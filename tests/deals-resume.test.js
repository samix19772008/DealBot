process.env.DATABASE_PATH = ':memory:';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { db } = require('../src/database/init');
const { createResumeHandler } = require('../src/interactions/buttons/dealsResume');
after(() => db.close());

const guildId = '940000000000000001';
const buyerId = '940000000000000002';
const sellerId = '940000000000000003';
const botId = '940000000000000004';
const staffId = '940000000000000005';
const parentId = '940000000000000006';
const threadId = '940000000000000007';
const ordinary = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory];

function fixture(options = {}) {
    let deal = { id: 1, guild_id: guildId, channel_id: threadId, status: 'funded', transaction_uuid: 'ESC-test',
        buyer_discord_id: buyerId, seller_discord_id: sellerId, ...options.deal };
    const calls = { defers: [], replies: [], edits: [], memberships: [], archives: [], threadEdits: [], reopened: [], fetches: [] };
    const userId = options.userId || buyerId;
    const member = { id: userId, guild: { id: guildId }, isStaff: Boolean(options.staff),
        permissions: new PermissionsBitField([...ordinary, ...(options.manage ? [PermissionFlagsBits.ManageThreads] : [])]) };
    const botMember = { id: botId, guild: { id: guildId }, permissions: new PermissionsBitField([...ordinary, PermissionFlagsBits.ManageThreads]) };
    const permissionsFor = value => value.id === botId ? botMember.permissions : member.permissions;
    const thread = { id: threadId, guildId, parentId, type: ChannelType.PrivateThread,
        archived: true, locked: false, permissionsFor,
        members: { fetch: async argument => { calls.memberships.push(argument); return options.removed ? null : { id: userId }; },
            add: async () => assert.fail('Resume must never add a private-thread member') },
        setArchived: async (value, reason) => { calls.archives.push({ value, reason }); thread.archived = value; },
        edit: async value => { calls.threadEdits.push(value); Object.assign(thread, value); },
        ...options.thread };
    const parent = { id: parentId, guildId, type: ChannelType.GuildText, permissionsFor, ...options.parent };
    const guild = { id: guildId, channels: { fetch: async (id, fetchOptions) => {
        calls.fetches.push({ id, ...fetchOptions });
        if (options.onChannelFetch) await options.onChannelFetch(id, { deal, thread, member, calls, setDeal: next => { deal = next; } });
        return id === threadId ? thread : id === parentId ? parent : null;
    } }, members: { fetch: async argument => {
        assert.equal(argument.force, true);
        assert.equal(argument.cache, false);
        return options.leftGuild ? null : member;
    }, fetchMe: async () => botMember } };
    const client = { guilds: { fetch: async () => guild } };
    const interaction = { guildId, customId: 'deals_resume_1', user: { id: userId }, client,
        deferReply: async value => { interaction.deferred = true; calls.defers.push(value); },
        reply: async value => calls.replies.push(value), editReply: async value => calls.edits.push(value) };
    const handler = createResumeHandler({ getDeal: () => deal, moderator: candidate => candidate.isStaff,
        reopened: id => calls.reopened.push(id) });
    return { handler, interaction, calls, deal, member, botMember, thread, parent, client, setDeal: next => { deal = next; } };
}

test('an existing participant can resume an unlocked active private conversation with fresh membership checks', async () => {
    const f = fixture();
    await f.handler.execute(f.interaction);
    assert.deepEqual(f.calls.defers, [{ ephemeral: true }]);
    assert.equal(f.calls.archives.length, 1);
    assert.equal(f.calls.archives[0].value, false);
    assert.deepEqual(f.calls.reopened, [1]);
    assert.equal(f.calls.memberships.length, 2);
    assert.ok(f.calls.memberships.every(value => value.member === buyerId && value.force && value.cache === false));
    assert.ok(f.calls.fetches.every(value => value.force && value.cache === false));
    assert.match(f.calls.edits[0].content, new RegExp(`https://discord.com/channels/${guildId}/${threadId}`));
    assert.deepEqual(f.calls.edits[0].allowedMentions, { parse: [] });
});

test('completed, cancelled, refunded, pending and foreign-server deals cannot be resumed', async () => {
    for (const status of ['completed', 'cancelled', 'refunded', 'pending']) {
        const f = fixture({ deal: { status } });
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.equal(f.calls.defers.length, 0);
        assert.equal(f.calls.replies[0].ephemeral, true);
        assert.match(f.calls.replies[0].content, /Only an active deal/);
    }
    for (const changes of [{ guildId: 'another-server' }, { guildId: null }, { customId: 'deals_resume_bad' }]) {
        const f = fixture(); Object.assign(f.interaction, changes);
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.defers.length, 0);
        assert.equal(f.calls.archives.length, 0);
        assert.match(f.calls.replies[0].content, /not found/);
    }
});

test('other traders, removed participants and departed server members cannot recover private-thread access', async () => {
    for (const options of [{ userId: 'stranger' }, { removed: true }, { removed: true, manage: true }, { leftGuild: true }]) {
        const f = fixture(options);
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.equal(f.calls.threadEdits.length, 0);
        assert.match(f.calls.edits[0].content, /could not be resumed/);
        assert.doesNotMatch(f.calls.edits[0].content, /discord\.com\/channels/);
    }
});

test('ordinary participants and staff without current Manage Threads cannot unlock a staff-locked conversation', async () => {
    for (const options of [{}, { manage: true }, { userId: staffId, staff: true }]) {
        const f = fixture({ ...options, thread: { locked: true } });
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.equal(f.calls.threadEdits.length, 0);
        assert.match(f.calls.edits[0].content, /locked by staff/);
    }
});

test('authorized staff with current Manage Threads can atomically unlock and resume without adding themselves', async () => {
    const f = fixture({ userId: staffId, staff: true, manage: true, removed: true, thread: { locked: true } });
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.equal(f.calls.threadEdits.length, 1);
    assert.equal(f.calls.threadEdits[0].archived, false);
    assert.equal(f.calls.threadEdits[0].locked, false);
    assert.equal(f.calls.memberships.length, 0);
    assert.deepEqual(f.calls.reopened, [1]);
});

test('effective parent or bot permissions, foreign threads and public threads cannot be bypassed', async () => {
    const cases = [
        { parent: { permissionsFor: () => new PermissionsBitField() } },
        { thread: { permissionsFor: member => new PermissionsBitField(member.id === botId ? ordinary : [...ordinary]) } },
        { thread: { guildId: 'another-guild' } },
        { thread: { type: ChannelType.PublicThread } },
        { parent: { guildId: 'another-guild' } },
    ];
    for (const options of cases) {
        const f = fixture(options);
        await f.handler.execute(f.interaction);
        assert.equal(f.calls.archives.length, 0);
        assert.match(f.calls.edits[0].content, /could not be resumed/);
    }
});

test('an already open active conversation returns its link without mutation or reopening metadata', async () => {
    const f = fixture({ thread: { archived: false } });
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.equal(f.calls.threadEdits.length, 0);
    assert.equal(f.calls.reopened.length, 0);
    assert.match(f.calls.edits[0].content, /Continue in your private deal conversation/);
});

test('a deal completing during fresh Discord access checks is not reopened', async () => {
    const f = fixture({ onChannelFetch: async (id, context) => {
        if (id === parentId) context.setDeal({ ...context.deal, status: 'completed' });
    } });
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.match(f.calls.edits[0].content, /ended or changed/);
});

test('permissions lost during the final refresh block the Discord mutation', async () => {
    let parentReads = 0;
    const f = fixture({ onChannelFetch: async (id, context) => {
        if (id === parentId && ++parentReads === 2) context.member.permissions = new PermissionsBitField();
    } });
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.match(f.calls.edits[0].content, /could not be resumed/);
});

test('fresh parent permissions prevent staff from unlocking through a stale thread permission cache', async () => {
    const f = fixture({ userId: staffId, staff: true, manage: true, thread: { locked: true } });
    // Discord thread permissions are normally inherited from a cached parent. Require both current views.
    f.parent.permissionsFor = member => member.id === botId ? f.botMember.permissions : new PermissionsBitField(ordinary);
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.threadEdits.length, 0);
    assert.match(f.calls.edits[0].content, /locked by staff/);
});

test('private-thread membership removed during the final refresh is not recreated', async () => {
    const f = fixture();
    let fetches = 0;
    f.thread.members.fetch = async () => ++fetches === 1 ? { id: buyerId } : null;
    await f.handler.execute(f.interaction);
    assert.equal(fetches, 2);
    assert.equal(f.calls.archives.length, 0);
    assert.match(f.calls.edits[0].content, /could not be resumed/);
});

test('shutdown during permission checks leaves the conversation archived', async () => {
    const f = fixture(); f.client.dealBotStopping = true;
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 0);
    assert.match(f.calls.edits[0].content, /restarting/);
});

test('lost Discord edit responses recognize an actual successful resume without repeating the mutation', async () => {
    const f = fixture();
    f.thread.setArchived = async value => { f.calls.archives.push(value); f.thread.archived = false; throw Object.assign(new Error('Lost response'), { code: 'ETIMEDOUT' }); };
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.archives.length, 1);
    assert.deepEqual(f.calls.reopened, [1]);
    assert.match(f.calls.edits[0].content, /Continue in your private deal conversation/);
});

test('a failed Discord edit does not claim the conversation was resumed', async () => {
    const f = fixture();
    f.thread.setArchived = async () => { throw Object.assign(new Error('Denied'), { code: 50013 }); };
    await f.handler.execute(f.interaction);
    assert.equal(f.calls.reopened.length, 0);
    assert.match(f.calls.edits[0].content, /could not be resumed/);
});
