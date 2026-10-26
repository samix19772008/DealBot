process.env.DATABASE_PATH = ':memory:';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { db } = require('../src/database/init');
const { createHideHandler } = require('../src/interactions/buttons/dealsHide');
after(() => db.close());

const ids = { guild: '950000000000000001', buyer: '950000000000000002', seller: '950000000000000003',
    bot: '950000000000000004', parent: '950000000000000005', thread: '950000000000000006' };
const ordinary = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads];

function fixture(options = {}) {
    let deal = { id: 1, guild_id: ids.guild, channel_id: ids.thread, status: 'funded', transaction_uuid: 'ESC-hide-test',
        buyer_discord_id: ids.buyer, seller_discord_id: ids.seller, ...options.deal };
    const calls = { replies: [], defers: [], edits: [], archives: [], memberships: [], channels: [] };
    const userId = options.userId || ids.buyer;
    const member = { id: userId, guild: { id: ids.guild }, permissions: new PermissionsBitField(ordinary) };
    const bot = { id: ids.bot, guild: { id: ids.guild }, permissions: new PermissionsBitField([...ordinary, PermissionFlagsBits.ManageThreads]) };
    const permissionsFor = who => who.id === ids.bot ? bot.permissions : member.permissions;
    const thread = { id: ids.thread, guildId: ids.guild, parentId: ids.parent, type: ChannelType.PrivateThread,
        archived: false, locked: false, permissionsFor,
        members: { fetch: async value => {
            calls.memberships.push(value);
            return options.removed ? null : { id: userId };
        }, add: async () => assert.fail('Hiding must not restore private-thread membership') },
        setArchived: async (value, reason) => { calls.archives.push({ value, reason }); thread.archived = value; return thread; },
        setLocked: async () => assert.fail('Hiding must not lock or unlock a conversation'),
        delete: async () => assert.fail('Hiding must not delete a conversation'),
        send: async () => assert.fail('Hiding must not send a closing transcript or a public message'),
        ...options.thread };
    const parent = { id: ids.parent, guildId: ids.guild, type: ChannelType.GuildText, permissionsFor, ...options.parent };
    const guild = { id: ids.guild,
        channels: { fetch: async (id, fetchOptions) => {
            calls.channels.push({ id, ...fetchOptions });
            if (options.onChannelFetch) await options.onChannelFetch(id, { deal, member, bot, thread, calls,
                setDeal: next => { deal = next; } });
            return id === ids.thread ? thread : id === ids.parent ? parent : null;
        } },
        members: { fetch: async value => {
            assert.deepEqual(value, { user: userId, force: true, cache: false });
            return options.leftGuild ? null : member;
        }, fetchMe: async value => { assert.deepEqual(value, { force: true, cache: false }); return bot; } } };
    const client = { guilds: { fetch: async id => id === ids.guild ? guild : null } };
    const interaction = { guildId: ids.guild, user: { id: userId }, customId: 'deals_hide_1', client,
        deferReply: async value => { interaction.deferred = true; calls.defers.push(value); },
        reply: async value => { calls.replies.push(value); }, editReply: async value => { calls.edits.push(value); } };
    return { handler: createHideHandler({ getDeal: () => deal }), interaction, calls, client, member, bot, parent, thread,
        getDeal: () => deal, setDeal: next => { deal = next; } };
}

test('a participant can hide an active conversation for both members without closing, deleting, locking, or changing its deal', async () => {
    for (const userId of [ids.buyer, ids.seller]) {
        const f = fixture({ userId });
        const before = structuredClone(f.getDeal());
        await f.handler.execute(f.interaction);
        assert.deepEqual(f.calls.defers, [{ ephemeral: true }]);
        assert.equal(f.calls.archives.length, 1);
        assert.equal(f.calls.archives[0].value, true);
        assert.equal(f.thread.locked, false);
        assert.deepEqual(f.getDeal(), before);
        assert.equal(f.calls.memberships.length, 2);
        assert.ok(f.calls.memberships.every(value => value.member === userId && value.force && value.cache === false));
        assert.ok(f.calls.channels.every(value => value.force && value.cache === false));
        assert.match(f.calls.edits[0].content, /for both participants/);
        assert.match(f.calls.edits[0].content, /still active and all messages are kept/);
        assert.match(f.calls.edits[0].content, /No closing transcript/);
        assert.deepEqual(f.calls.edits[0].allowedMentions, { parse: [] });
    }
});

test('strangers, other servers, DMs, and malformed hide references are rejected before Discord is inspected', async () => {
    const stranger = fixture({ userId: 'stranger' });
    stranger.interaction.memberPermissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
    await stranger.handler.execute(stranger.interaction);
    assert.equal(stranger.calls.channels.length, 0);
    assert.equal(stranger.calls.defers.length, 0);
    assert.equal(stranger.calls.replies[0].ephemeral, true);
    assert.match(stranger.calls.replies[0].content, /not one of your deals/);
    for (const changes of [{ guildId: null }, { guildId: 'other-server' }, { customId: 'deals_hide_not-numeric' }]) {
        const f = fixture(); Object.assign(f.interaction, changes);
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.channels.length, 0);
        assert.equal(f.calls.defers.length, 0);
        assert.equal(f.calls.replies[0].ephemeral, true);
        assert.equal(f.calls.archives.length, 0);
    }
});

test('pending, disputed, ended, or missing-thread deals are not hidden', async () => {
    for (const deal of [{ status: 'pending' }, { status: 'disputed' }, { status: 'completed' }, { status: 'cancelled' },
        { status: 'refunded' }, { channel_id: null }]) {
        const f = fixture({ deal });
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.equal(f.calls.channels.length, 0);
        assert.match(f.calls.replies[0].content, /Only an active, undisputed/);
    }
});

test('removed private-thread members and departed server members cannot hide a conversation', async () => {
    for (const options of [{ removed: true }, { leftGuild: true }]) {
        const f = fixture(options);
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.match(f.calls.edits[0].content, /could not be hidden/);
    }
});

test('current thread and parent permissions, identities, and private-channel scope are required', async () => {
    for (const options of [
        { thread: { guildId: 'other-server' } }, { thread: { type: ChannelType.PublicThread } },
        { thread: { id: 'other-thread' } }, { parent: { guildId: 'other-server' } },
        { parent: { type: ChannelType.GuildVoice } }, { parent: { permissionsFor: () => new PermissionsBitField() } },
        { thread: { permissionsFor: () => new PermissionsBitField(ordinary) } },
    ]) {
        const f = fixture(options);
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.match(f.calls.edits[0].content, /could not be hidden/);
    }
});

test('a staff lock is respected even if a participating user has administrative permissions', async () => {
    const f = fixture({ thread: { locked: true } });
    f.member.permissions.add(PermissionFlagsBits.Administrator);
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.equal(f.thread.locked, true);
    assert.match(f.calls.edits[0].content, /locked by staff/);
});

test('an already hidden active conversation returns its saved state without another archive operation', async () => {
    const f = fixture({ thread: { archived: true } });
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.match(f.calls.edits[0].content, /Conversation archived for both participants/);
});

test('a deal that becomes disputed or changes its conversation during access checks cannot be hidden', async () => {
    for (const change of [{ status: 'disputed' }, { channel_id: 'replacement-thread' }, { guild_id: 'other-server' }]) {
        const f = fixture({ onChannelFetch: async (id, context) => {
            if (id === ids.parent) context.setDeal({ ...context.deal, ...change });
        } });
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.match(f.calls.edits[0].content, /has changed/);
    }
});

test('losing private membership or fresh parent permission in the final refresh prevents hiding', async () => {
    const membership = fixture();
    let reads = 0;
    membership.thread.members.fetch = async () => ++reads === 1 ? { id: ids.buyer } : null;
    await membership.handler.execute(membership.interaction);
    assert.equal(reads, 2);
    assert.equal(membership.calls.archives.length, 0);
    const permissions = fixture({ onChannelFetch: async (id, context) => {
        if (id === ids.parent && context.calls.channels.filter(call => call.id === ids.parent).length === 2) {
            context.member.permissions = new PermissionsBitField();
        }
    } });
    await permissions.handler.execute(permissions.interaction);
    assert.equal(permissions.calls.archives.length, 0);
});

test('shutdown after access checks leaves the conversation open', async () => {
    const f = fixture(); f.client.dealBotStopping = true;
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.match(f.calls.edits[0].content, /restarting/);
});

test('a lost archive acknowledgement recognizes only an actual private archive in the original server', async () => {
    const f = fixture();
    f.thread.setArchived = async value => {
        f.calls.archives.push({ value }); f.thread.archived = true;
        throw Object.assign(new Error('Lost acknowledgement'), { code: 'ETIMEDOUT' });
    };
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 1);
    assert.match(f.calls.edits[0].content, /Conversation archived for both participants/);
});

test('a failed archive call never reports a successful hide', async () => {
    const f = fixture();
    f.thread.setArchived = async () => { throw Object.assign(new Error('Denied'), { code: 50013 }); };
    await f.handler.execute(f.interaction);
    assert.equal(f.thread.archived, false);
    assert.match(f.calls.edits[0].content, /could not be hidden/);
    assert.doesNotMatch(f.calls.edits[0].content, /Conversation archived for both participants/);
});
