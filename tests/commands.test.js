process.env.DATABASE_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionsBitField, PermissionFlagsBits, ChannelType } = require('discord.js');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { createEscrow } = require('../src/database/escrowRepository');
const { getGuildSettings, setModeratorRole } = require('../src/database/guildSettingsRepository');
const { isSafeRankRole } = require('../src/utils/roleSync');

const commands = [];
for (const folder of fs.readdirSync(path.join(__dirname, '../src/commands'))) {
    for (const file of fs.readdirSync(path.join(__dirname, '../src/commands', folder))) {
        if (file.endsWith('.js')) commands.push(require(path.join(__dirname, '../src/commands', folder, file)));
    }
}
const command = name => commands.find(value => value.data.name === name);
const perms = (...flags) => new PermissionsBitField(flags);
const noPermissions = () => perms();

function cleanDatabase() {
    db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;');
}
function discordUser(id) {
    return { id, tag: `User${id}`, createdAt: new Date('2020-01-01T00:00:00Z'), bot: false };
}
function seedDeal(guildId = 'guild-a', buyerId = 'buyer', sellerId = 'seller') {
    const buyer = getOrCreateUser(discordUser(buyerId));
    const seller = getOrCreateUser(discordUser(sellerId));
    return createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id, itemDescription: 'A service', amount: 25.5, currency: 'USD' });
}
function interaction(options = {}) {
    const replies = [];
    return {
        guildId: 'guild-a',
        user: discordUser('buyer'),
        memberPermissions: noPermissions(),
        member: { roles: { cache: new Map() }, permissions: noPermissions(), guild: { id: 'guild-a' } },
        options: { getString: () => null, getInteger: () => null },
        replies,
        reply: async payload => { replies.push(payload); return payload; },
        deferReply: async payload => { replies.push({ deferred: true, ...payload }); },
        editReply: async payload => { replies.push(payload); return payload; },
        ...options,
    };
}

test('every command definition is English, unique, valid, and unavailable in DMs', () => {
    const names = new Set();
    assert.equal(commands.length, 15);
    for (const entry of commands) {
        const data = entry.data.toJSON();
        assert.equal(data.dm_permission, false, data.name);
        assert.equal(/[\u0600-\u06ff]/u.test(JSON.stringify(data)), false, data.name);
        assert.equal(names.has(data.name), false, `Duplicate ${data.name}`);
        names.add(data.name);
    }
    assert.deepEqual(command('set-language').data.toJSON().options[0].choices.map(({ name, value }) => ({ name, value })), [{ name: 'English', value: 'en' }]);
});

test('all setup commands independently reject a member without Administrator', async () => {
    cleanDatabase();
    for (const name of ['set-hub-channel', 'set-mod-role', 'set-rank-role', 'set-rank', 'set-language', 'setup', 'stats', 'review-flag']) {
        const input = interaction();
        await command(name).execute(input);
        assert.equal(input.replies.length, 1, name);
        assert.equal(input.replies[0].ephemeral, true, name);
        assert.match(input.replies[0].content, /administrator/i, name);
    }
    assert.equal(getGuildSettings('guild-a'), undefined);
});

test('/deals only lists the current user\'s deals in the selected server', async () => {
    cleanDatabase();
    const own = seedDeal();
    const otherGuild = seedDeal('guild-b');
    const otherUser = seedDeal('guild-a', 'stranger', 'seller');
    const input = interaction();
    await command('deals').execute(input);
    assert.equal(input.replies[0].ephemeral, true);
    const output = JSON.stringify(input.replies[0].embeds[0].toJSON());
    assert.ok(output.includes(own.transaction_uuid));
    assert.ok(!output.includes(otherGuild.transaction_uuid));
    assert.ok(!output.includes(otherUser.transaction_uuid));
});

test('/deals pagination returns different records and rejects invalid pages', async () => {
    cleanDatabase();
    for (let i = 0; i < 8; i++) seedDeal();
    const first = interaction({ options: { getString: () => 'all', getInteger: () => 1 } });
    const second = interaction({ options: { getString: () => 'all', getInteger: () => 2 } });
    await command('deals').execute(first);
    await command('deals').execute(second);
    const a = first.replies[0].embeds[0].toJSON().fields;
    const b = second.replies[0].embeds[0].toJSON().fields;
    assert.equal(a.length, 6);
    assert.equal(b.length, 2);
    assert.ok(!a.some(field => b.some(other => other.name === field.name)));
    const invalid = interaction({ options: { getString: () => 'active', getInteger: () => -2 } });
    await command('deals').execute(invalid);
    assert.match(invalid.replies[0].content, /valid|between/);
});

test('/deal-status denies unauthorized users and cross-server references', async () => {
    cleanDatabase();
    const own = seedDeal();
    const foreign = seedDeal('guild-b');
    for (const [reference, userId] of [[own.transaction_uuid, 'stranger'], [foreign.transaction_uuid, 'buyer']]) {
        const input = interaction({
            user: discordUser(userId), options: { getString: () => reference },
        });
        await command('deal-status').execute(input);
        assert.equal(input.replies[0].ephemeral, true);
        assert.match(input.replies[0].content, /not found|permission/);
        assert.equal(input.replies[0].embeds, undefined);
    }
});

test('/deal-status permits participants and configured staff, including recorded timeline', async () => {
    cleanDatabase();
    const own = seedDeal();
    setModeratorRole('guild-a', 'staff');
    for (const userId of ['buyer', 'staff-user']) {
        const input = interaction({
            user: discordUser(userId), options: { getString: () => own.transaction_uuid },
            member: { roles: { cache: new Map(userId === 'staff-user' ? [['staff', {}]] : []) }, permissions: noPermissions(), guild: { id: 'guild-a' } },
        });
        await command('deal-status').execute(input);
        const output = JSON.stringify(input.replies[0].embeds[0].toJSON());
        assert.equal(input.replies[0].ephemeral, true);
        assert.ok(output.includes(own.transaction_uuid));
        assert.ok(output.includes('pending'));
        assert.ok(output.includes('Recent Activity'));
    }
});

test('/deal rejects unsupported, fractional-game, and invalid payments before creating a request', async () => {
    cleanDatabase();
    for (const [method, amount, unit] of [['bitcoin', 2, 'each'], ['money', 0, 'each'], ['money', 1.001, 'each'], ['money', 2, 'stacks'], ['golds', 2.5, 'each']]) {
        const input = interaction({ options: {
            getString: name => ({ item: 'Example', payment: method, unit })[name],
            getNumber: () => amount,
            getUser: () => discordUser('seller'),
        } });
        await command('deal').execute(input);
        assert.equal(input.replies[0].ephemeral, true);
        assert.match(input.replies[0].content, /Choose one payment|amount|Money|whole number/);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escrow_transactions').get().n, 0);
    }
});

test('rank-role validation rejects staff privileges, managed roles, and hierarchy conflicts', () => {
    const bot = { permissions: perms(PermissionFlagsBits.ManageRoles), roles: { highest: { position: 10 } } };
    const cosmetic = { id: 'cosmetic', managed: false, editable: true, position: 2, permissions: perms() };
    assert.equal(isSafeRankRole(cosmetic, bot, 'guild-a'), true);
    assert.equal(isSafeRankRole({ ...cosmetic, id: 'guild-a' }, bot, 'guild-a'), false);
    assert.equal(isSafeRankRole({ ...cosmetic, managed: true }, bot, 'guild-a'), false);
    assert.equal(isSafeRankRole({ ...cosmetic, position: 10 }, bot, 'guild-a'), false);
    assert.equal(isSafeRankRole({ ...cosmetic, permissions: perms(PermissionFlagsBits.ManageThreads) }, bot, 'guild-a'), false);
    assert.equal(isSafeRankRole(cosmetic, { ...bot, permissions: perms() }, 'guild-a'), false);
});

test('/set-hub-channel does not save a hub with insufficient bot permissions', async () => {
    cleanDatabase();
    const input = interaction({
        memberPermissions: perms(PermissionFlagsBits.Administrator),
        guild: { members: { me: {} } },
        options: { getChannel: () => ({ id: 'hub', guildId: 'guild-a', type: ChannelType.GuildText, permissionsFor: () => perms() }) },
    });
    await command('set-hub-channel').execute(input);
    assert.match(input.replies.at(-1), /Create Private Threads/);
    assert.equal(getGuildSettings('guild-a'), undefined);
});

test('/help explains manual payment tracking and the available workflow', async () => {
    const input = interaction();
    await command('help').execute(input);
    const json = input.replies[0].embeds[0].toJSON();
    assert.equal(input.replies[0].ephemeral, true);
    assert.match(JSON.stringify(json), /does not hold funds/);
    assert.ok(json.fields.some(field => field.value.includes('/deal-status')));
    assert.match(JSON.stringify(json), /public-offer:true/);
    assert.match(JSON.stringify(json), /cancelled without posting/);
    assert.ok(JSON.stringify(json).length < 6000);
});


function controlIds(payload) {
    return (payload.components ?? []).flatMap(row => row.toJSON().components.map(button => button.custom_id));
}

test('/deal-status restores actor-specific pending controls in the matching server', async () => {
    cleanDatabase();
    const own = seedDeal();
    const input = interaction({ channelId: 'general', options: { getString: () => own.transaction_uuid } });
    await command('deal-status').execute(input);
    const ids = controlIds(input.replies[0]);
    assert.ok(!ids.includes(`accept_escrow_${own.id}`));
    assert.ok(ids.includes(`cancel_escrow_${own.id}`));
    const seller = interaction({ user: discordUser('seller'), channelId: 'general', options: { getString: () => own.transaction_uuid } });
    await command('deal-status').execute(seller);
    const sellerIds = controlIds(seller.replies[0]);
    assert.ok(sellerIds.includes(`accept_escrow_${own.id}`));
    assert.ok(sellerIds.includes(`cancel_escrow_${own.id}`));
});

test('/deal-status restores the current payment, delivery, or receipt controls only in the deal thread', async () => {
    cleanDatabase();
    const own = seedDeal();
    for (const [status, action] of [
        ['awaiting_payment', 'confirm_payment'],
        ['funded', 'confirm_delivery'],
        ['delivered', 'confirm_receipt'],
    ]) {
        db.prepare('UPDATE escrow_transactions SET status = ?, channel_id = ? WHERE id = ?').run(status, 'deal-thread', own.id);
        const input = interaction({ user: discordUser(status === 'funded' ? 'seller' : 'buyer'), channelId: 'deal-thread', options: { getString: () => own.transaction_uuid } });
        await command('deal-status').execute(input);
        const ids = controlIds(input.replies[0]);
        assert.ok(ids.includes(`${action}_${own.id}`), status);
        assert.ok(ids.includes(`open_dispute_${own.id}`), status);
        const outside = interaction({ channelId: 'general', options: { getString: () => own.transaction_uuid } });
        await command('deal-status').execute(outside);
        assert.deepEqual(controlIds(outside.replies[0]), []);
        assert.match(JSON.stringify(outside.replies[0].embeds[0].toJSON()), /inside the private thread/);
    }
});

test('/deal-status limits recovered dispute resolution and force-close controls to staff', async () => {
    cleanDatabase();
    const own = seedDeal();
    setModeratorRole('guild-a', 'staff');
    const staff = { roles: { cache: new Map([['staff', {}]]) }, permissions: noPermissions(), guild: { id: 'guild-a' } };
    for (const status of ['disputed', 'completed']) {
        db.prepare('UPDATE escrow_transactions SET status = ?, channel_id = ? WHERE id = ?').run(status, 'deal-thread', own.id);
        const participant = interaction({ channelId: 'deal-thread', options: { getString: () => own.transaction_uuid } });
        const moderator = interaction({ user: discordUser('moderator'), member: staff, channelId: 'deal-thread', options: { getString: () => own.transaction_uuid } });
        await command('deal-status').execute(participant);
        await command('deal-status').execute(moderator);
        const participantIds = controlIds(participant.replies[0]);
        const moderatorIds = controlIds(moderator.replies[0]);
        if (status === 'disputed') {
            assert.deepEqual(participantIds, []);
            for (const action of ['resolve_complete', 'resolve_cancel', 'resolve_scammer']) {
                assert.ok(moderatorIds.includes(`${action}_${own.id}`));
            }
        } else {
            assert.ok(participantIds.includes(`approve_close_${own.id}`));
            assert.ok(!participantIds.includes(`admin_close_${own.id}`));
            assert.ok(moderatorIds.includes(`admin_close_${own.id}`));
        }
    }
});


test('/deals and /deal-status expire only stale pending requests in the current server', async () => {
    cleanDatabase();
    const own = seedDeal();
    const foreign = seedDeal('guild-b');
    db.prepare("UPDATE escrow_transactions SET created_at = datetime('now', '-25 hours') WHERE id IN (?, ?)").run(own.id, foreign.id);
    const list = interaction();
    await command('deals').execute(list);
    assert.equal(list.replies[0].embeds[0].toJSON().fields?.length ?? 0, 0);
    assert.equal(db.prepare('SELECT status FROM escrow_transactions WHERE id = ?').get(own.id).status, 'cancelled');
    assert.equal(db.prepare('SELECT status FROM escrow_transactions WHERE id = ?').get(foreign.id).status, 'pending');
    const details = interaction({ options: { getString: () => own.transaction_uuid } });
    await command('deal-status').execute(details);
    assert.match(JSON.stringify(details.replies[0].embeds[0].toJSON()), /request ended before a private conversation/);
    assert.deepEqual(controlIds(details.replies[0]), []);
});
