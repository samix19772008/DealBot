process.env.DATABASE_PATH = ':memory:';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { createEscrow } = require('../src/database/escrowRepository');
const { setHubChannel, setModeratorRole, setRankRole } = require('../src/database/guildSettingsRepository');
const setup = require('../src/commands/general/setup');
const stats = require('../src/commands/general/stats');

const permissions = (...flags) => new PermissionsBitField(flags);
const HUB_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];
const STAFF_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads];

function fixture({ configured = false, administrator = true } = {}) {
    const calls = { fetches: 0, writes: 0, replies: [] };
    const bot = { id: 'bot', permissions: permissions(...HUB_PERMISSIONS), roles: { highest: { position: 10 } } };
    const staff = { id: 'staff', managed: false, permissions: permissions(...STAFF_PERMISSIONS) };
    const cosmetic = { id: 'cosmetic', managed: false, editable: true, position: 2, permissions: permissions() };
    const hub = { id: 'hub', guildId: 'guild-a', type: ChannelType.GuildText,
        permissionsFor: member => member?.id === bot.id ? bot.permissions : staff.permissions };
    const guild = { id: 'guild-a', members: { fetchMe: async () => { calls.fetches++; return bot; } },
        channels: { fetch: async channelId => { calls.fetches++; return channelId === hub.id ? hub : null; }, create: async () => { calls.writes++; } },
        roles: { fetch: async roleId => { calls.fetches++; return roleId === staff.id ? staff : roleId === cosmetic.id ? cosmetic : null; }, create: async () => { calls.writes++; } } };
    if (configured) {
        setHubChannel(guild.id, hub.id);
        setModeratorRole(guild.id, staff.id);
    }
    const interaction = { guildId: guild.id, guild, user: { id: 'admin' },
        memberPermissions: administrator ? permissions(PermissionFlagsBits.Administrator) : permissions(),
        deferReply: async payload => { calls.replies.push({ deferred: true, ...payload }); },
        reply: async payload => { calls.replies.push(payload); },
        editReply: async payload => { calls.replies.push(payload); } };
    return { calls, bot, staff, cosmetic, hub, interaction };
}
const output = f => f.calls.replies.at(-1).embeds[0].toJSON();
const field = (embed, name) => embed.fields.find(value => value.name === name)?.value;
function identity(id) {
    return getOrCreateUser({ id, tag: `Private_${id}`, createdAt: new Date('2020-01-01') });
}
function seedDeal(guildId, buyerId, sellerId, status = 'pending', old = false) {
    const escrow = createEscrow({ guildId, buyerId: identity(buyerId).id, sellerId: identity(sellerId).id,
        itemDescription: 'Private item details', amount: 999, currency: 'USD' });
    db.prepare('UPDATE escrow_transactions SET status = ? WHERE id = ?').run(status, escrow.id);
    if (old) db.prepare("UPDATE escrow_transactions SET created_at = datetime('now', '-45 days') WHERE id = ?").run(escrow.id);
    return escrow;
}

beforeEach(() => db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;'));
after(() => db.close());

test('/setup and /stats require Administrator before inspecting server resources', async () => {
    for (const command of [setup, stats]) {
        const f = fixture({ administrator: false });
        await command.execute(f.interaction);
        assert.equal(f.calls.fetches, 0);
        assert.equal(f.calls.replies.length, 1);
        assert.equal(f.calls.replies[0].ephemeral, true);
        assert.match(f.calls.replies[0].content, /administrator/i);
    }
});

test('/setup missing configuration gives actionable commands and performs no writes', async () => {
    const f = fixture();
    const before = db.prepare('SELECT * FROM guild_settings').all();
    await setup.execute(f.interaction);
    const embed = output(f);
    assert.match(embed.description, /need attention/);
    assert.match(field(embed, 'Required · Escrow Hub'), /set-hub-channel/);
    assert.match(field(embed, 'Required · Dispute Staff'), /set-mod-role/);
    assert.match(field(embed, 'Optional · Trust Rank Roles'), /work without rank roles/);
    assert.equal(f.calls.replies[0].ephemeral, true);
    assert.equal(f.calls.writes, 0);
    assert.deepEqual(db.prepare('SELECT * FROM guild_settings').all(), before);
});

test('/setup ready configuration passes without requiring optional rank-role permissions', async () => {
    const f = fixture({ configured: true });
    assert.equal(f.bot.permissions.has(PermissionFlagsBits.ManageRoles), false);
    const before = db.prepare('SELECT * FROM guild_settings').all();
    await setup.execute(f.interaction);
    const embed = output(f);
    assert.match(embed.description, /Required setup checks passed/);
    assert.match(field(embed, 'Required · Bot Permissions'), /every required/);
    assert.match(field(embed, 'Required · Dispute Staff'), /can read and manage/);
    assert.equal(f.calls.writes, 0);
    assert.deepEqual(db.prepare('SELECT * FROM guild_settings').all(), before);
});

test('/setup detects effective bot and staff channel-permission failures', async () => {
    const f = fixture({ configured: true });
    f.bot.permissions = permissions(...HUB_PERMISSIONS.filter(flag => flag !== PermissionFlagsBits.ManageThreads));
    f.staff.permissions = permissions(PermissionFlagsBits.ViewChannel);
    await setup.execute(f.interaction);
    const embed = output(f);
    assert.match(embed.description, /need attention/);
    assert.match(field(embed, 'Required · Bot Permissions'), /Manage Threads/);
    assert.match(field(embed, 'Required · Dispute Staff'), /Read Message History.*Send Messages in Threads.*Manage Threads/);
    assert.equal(f.calls.writes, 0);
});

test('/setup diagnoses deleted hub and staff roles instead of claiming readiness', async () => {
    const f = fixture({ configured: true });
    f.interaction.guild.channels.fetch = async () => null;
    f.interaction.guild.roles.fetch = async () => null;
    await setup.execute(f.interaction);
    const embed = output(f);
    assert.match(embed.description, /need attention/);
    assert.match(field(embed, 'Required · Escrow Hub'), /not configured/);
    assert.match(field(embed, 'Required · Dispute Staff'), /set-mod-role/);
});

test('/setup marks unsafe optional rank mappings without blocking an otherwise ready server', async () => {
    const f = fixture({ configured: true });
    setRankRole('guild-a', 'bronze', 'cosmetic');
    f.cosmetic.permissions = permissions(PermissionFlagsBits.ManageThreads);
    f.bot.permissions.add(PermissionFlagsBits.ManageRoles);
    await setup.execute(f.interaction);
    const embed = output(f);
    assert.match(embed.description, /Required setup checks passed/);
    assert.match(field(embed, 'Optional · Trust Rank Roles'), /⚠️.*Bronze/);
    assert.match(field(embed, 'Optional · Trust Rank Roles'), /set-rank-role/);
    assert.equal(f.calls.writes, 0);
});

test('/stats uses only the current-server recent opened-deal group and separates all-date active counts', async () => {
    const examples = [
        seedDeal('guild-a', 'buyer-a', 'seller-a', 'completed'),
        seedDeal('guild-a', 'buyer-b', 'seller-a', 'disputed'),
        seedDeal('guild-a', 'buyer-a', 'seller-b', 'cancelled'),
        seedDeal('guild-a', 'buyer-a', 'seller-a', 'pending'),
        seedDeal('guild-a', 'buyer-old', 'seller-old', 'funded', true),
        seedDeal('guild-b', 'buyer-other', 'seller-other', 'completed'),
    ];
    const f = fixture();
    await stats.execute(f.interaction);
    const embed = output(f);
    assert.equal(f.calls.replies[0].ephemeral, true);
    assert.equal(field(embed, 'Deals Opened'), '4');
    assert.equal(field(embed, 'Currently Completed'), '1');
    assert.equal(field(embed, 'Currently Disputed'), '1');
    assert.equal(field(embed, 'Currently Cancelled'), '1');
    assert.equal(field(embed, 'Currently Refunded'), '0');
    assert.match(field(embed, 'Unique Traders'), /^4 participants/);
    assert.match(field(embed, 'Completion Rate'), /25\.0% \(1 completed \/ 4 opened\)/);
    assert.match(field(embed, 'All Current Active Deals'), /^3 /);
    const serialized = JSON.stringify(embed);
    for (const deal of examples) assert.ok(!serialized.includes(deal.transaction_uuid));
    assert.ok(!serialized.includes('Private_'));
    assert.ok(!serialized.includes('USD'));
    assert.equal(f.calls.fetches, 0);
});

test('/stats reports an empty window without an invented completion percentage', async () => {
    seedDeal('guild-b', 'foreign-buyer', 'foreign-seller', 'completed');
    const f = fixture();
    await stats.execute(f.interaction);
    const embed = output(f);
    assert.equal(field(embed, 'Deals Opened'), '0');
    assert.match(field(embed, 'Completion Rate'), /No deals/);
    assert.ok(!field(embed, 'Completion Rate').includes('%'));
});
