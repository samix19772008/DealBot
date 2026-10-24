const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_PATH = ':memory:';
const { db } = require('../src/database/init');
const escrowRepository = require('../src/database/escrowRepository');
const transcriptRepository = require('../src/database/transcriptRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
const { closeDealThread } = require('../src/utils/threadClosure');
const adminClose = require('../src/interactions/buttons/adminClose');
const approveClose = require('../src/interactions/buttons/approveClose');

const buyer = { id: '100000000000000001', tag: 'buyer#0001', createdAt: new Date('2020-01-01') };
const seller = { id: '100000000000000002', tag: 'seller#0001', createdAt: new Date('2020-01-01') };
const moderator = { id: '100000000000000003', tag: 'moderator#0001', createdAt: new Date('2020-01-01') };
const guildId = '200000000000000001';
const channelId = '300000000000000001';

beforeEach(() => db.exec('DELETE FROM escrow_thread_closures; DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;'));
after(() => db.close());

function completedDeal() {
    const b = getOrCreateUser(buyer);
    const s = getOrCreateUser(seller);
    const deal = escrowRepository.createEscrow({ guildId, buyerId: b.id, sellerId: s.id, itemDescription: 'Game item', amount: 10, currency: 'USD' });
    escrowRepository.acceptEscrow(deal.id, channelId, seller.id);
    escrowRepository.markAsFunded(deal.id, buyer.id);
    escrowRepository.markAsDelivered(deal.id, seller.id);
    escrowRepository.completeEscrow(deal.id, b.id, s.id, buyer.id);
    return escrowRepository.getEscrowById(deal.id);
}

function sdkThread(timestamp) {
    const calls = [];
    const thread = {
        id: channelId, archived: false, archiveTimestamp: (timestamp ?? Date.now()) - 10000, calls,
        isThread: () => true,
        client: { emit: (name, channel, time) => { calls.push(['emit', name, channel.id, time]); } },
        setLocked: async value => { calls.push(['lock', value]); return thread; },
        setArchived: async value => {
            calls.push(['archive', value]);
            thread.archived = value;
            thread.archiveTimestamp = timestamp ?? Date.now();
            return thread;
        },
    };
    return thread;
}

function closureOptions(channel, escrowId = 1, actor = buyer, kind = 'participant') {
    return { channel, escrowId, actor, kind, reason: 'Test closure' };
}

function fakeRepository(calls) {
    return {
        beginThreadClosure: (id, options) => { calls.push(['begin', id, options]); return 7; },
        failThreadClosure: requestId => { calls.push(['failed', requestId]); return true; },
        recordThreadArchive: (id, timestamp) => { calls.push(['record', id, timestamp]); return { id: 7, escrow_id: id, archive_timestamp: timestamp, status: 'archived' }; },
    };
}

function mockedInteraction(customId, user, channel) {
    const calls = { reply: [], followUp: [], editReply: [], send: [] };
    channel.send = async payload => { calls.send.push(payload); };
    return {
        customId, user, guildId, channelId, channel, calls,
        member: { guild: { id: guildId }, permissions: { has: () => user.id === moderator.id }, roles: { cache: new Map() } },
        message: { embeds: [], components: [] },
        deferUpdate: async function () { this.deferred = true; },
        reply: async payload => { calls.reply.push(payload); },
        followUp: async payload => { calls.followUp.push(payload); },
        editReply: async payload => { calls.editReply.push(payload); },
    };
}

test('actor metadata is saved after lock but before Discord can emit its archive event', async () => {
    const channel = sdkThread();
    const repo = fakeRepository(channel.calls);
    channel.setArchived = async value => {
        const pending = channel.calls.find(call => call[0] === 'begin');
        assert.deepEqual(pending[2], { actorId: buyer.id, actorName: buyer.tag, kind: 'participant' });
        channel.calls.push(['archive', value]);
        channel.archived = true;
        channel.archiveTimestamp = Date.now();
        return channel;
    };
    const result = await closeDealThread(closureOptions(channel), repo);
    assert.equal(result.archived, true);
    assert.equal(result.metadataPending, false);
    assert.deepEqual(channel.calls.map(call => call[0]), ['lock', 'begin', 'archive', 'record', 'emit']);
    assert.equal(channel.calls.at(-1)[1], 'dealThreadArchived');
    assert.equal(channel.calls.at(-1)[3], result.archiveTimestamp);
});

test('Gateway-first and REST-first observations bind the same closure and actor', async () => {
    for (const gatewayFirst of [true, false]) {
        const e = completedDeal();
        const channel = sdkThread();
        let gatewayRow;
        if (gatewayFirst) {
            const archive = channel.setArchived;
            channel.setArchived = async value => {
                await archive(value);
                gatewayRow = transcriptRepository.recordThreadArchive(e.id, channel.archiveTimestamp);
                return channel;
            };
        }
        const result = await closeDealThread(closureOptions(channel, e.id, moderator, 'moderator'));
        gatewayRow ||= transcriptRepository.recordThreadArchive(e.id, channel.archiveTimestamp);
        assert.equal(result.closure.id, gatewayRow.id);
        assert.equal(gatewayRow.actor_discord_id, moderator.id);
        assert.equal(gatewayRow.actor_name, moderator.tag);
        assert.equal(gatewayRow.kind, 'moderator');
        assert.equal(gatewayRow.archive_timestamp, channel.archiveTimestamp);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures WHERE escrow_id = ?').get(e.id).count, 1);
    }
});

test('a lock failure records no closure request or archive', async () => {
    const channel = sdkThread();
    channel.setLocked = async () => { throw new Error('Cannot lock'); };
    await assert.rejects(closeDealThread(closureOptions(channel), fakeRepository(channel.calls)), /Cannot lock/);
    assert.deepEqual(channel.calls, []);
});

test('an archive failure marks only the pending request failed and permits retry', async () => {
    const e = completedDeal();
    const channel = sdkThread();
    const archive = channel.setArchived;
    channel.setArchived = async () => { throw new Error('Cannot archive'); };
    await assert.rejects(closeDealThread(closureOptions(channel, e.id)), /Cannot archive/);
    const failed = db.prepare('SELECT * FROM escrow_thread_closures WHERE escrow_id = ?').get(e.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.archive_timestamp, null);
    assert.equal(channel.archived, false);
    assert.equal(channel.calls.some(call => call[0] === 'emit'), false);
    channel.setArchived = archive;
    const retried = await closeDealThread(closureOptions(channel, e.id, seller));
    assert.equal(retried.closure.status, 'archived');
    assert.equal(retried.closure.actor_discord_id, seller.id);
    assert.notEqual(retried.closure.id, failed.id);
});

test('a lost archive response is treated as success when forced fetch confirms archive', async () => {
    const channel = sdkThread();
    let timestamp;
    channel.setArchived = async () => { timestamp = Date.now(); throw new Error('Lost HTTP response'); };
    channel.fetch = async force => {
        assert.equal(force, true);
        return { ...channel, archived: true, archiveTimestamp: timestamp };
    };
    const result = await closeDealThread(closureOptions(channel), fakeRepository(channel.calls));
    assert.equal(result.archived, true);
    assert.equal(result.archiveTimestamp, timestamp);
    assert.equal(channel.calls.some(call => call[0] === 'failed'), false);
    assert.equal(channel.calls.at(-1)[0], 'emit');
});

test('metadata failure after successful archive never restores or marks closure failed', async () => {
    const channel = sdkThread();
    const repo = fakeRepository(channel.calls);
    repo.recordThreadArchive = () => { throw new Error('Database temporarily unavailable'); };
    const result = await closeDealThread(closureOptions(channel), repo);
    assert.equal(channel.archived, true);
    assert.equal(result.archived, true);
    assert.equal(result.metadataPending, true);
    assert.match(result.metadataError.message, /Database temporarily unavailable/);
    assert.equal(channel.calls.some(call => call[0] === 'failed'), false);
    assert.equal(channel.calls.at(-1)[0], 'emit');
});

test('an archive timestamp from an unarchived thread is never reused as closure time', async () => {
    const channel = sdkThread();
    channel.setArchived = async () => ({ archived: false, archiveTimestamp: 12345 });
    const result = await closeDealThread(closureOptions(channel), fakeRepository(channel.calls));
    assert.equal(result.archived, true);
    assert.equal(result.archiveTimestamp, null);
    assert.equal(result.metadataPending, true);
    assert.equal(channel.calls.some(call => call[0] === 'record'), false);
    assert.equal(channel.calls.at(-1)[3], null);
});

test('missing SDK timestamp is left pending rather than inventing Date.now', async () => {
    const channel = sdkThread();
    channel.setArchived = async () => { channel.archived = true; channel.archiveTimestamp = null; return channel; };
    const result = await closeDealThread(closureOptions(channel), fakeRepository(channel.calls));
    assert.equal(result.archiveTimestamp, null);
    assert.equal(result.metadataPending, true);
    assert.equal(channel.calls.some(call => call[0] === 'record' || call[0] === 'failed'), false);
});

test('a stale button on an already archived thread does not invent a new closer', async () => {
    const e = completedDeal();
    const channel = sdkThread();
    channel.archived = true;
    channel.archiveTimestamp = Date.now();
    const result = await closeDealThread(closureOptions(channel, e.id, moderator, 'moderator'));
    assert.equal(result.alreadyArchived, true);
    assert.equal(result.closure.kind, 'untracked');
    assert.equal(result.closure.actor_discord_id, null);
    assert.deepEqual(channel.calls.map(call => call[0]), ['emit']);
});

test('moderator close handler records the moderator tag and actual SDK timestamp', async () => {
    const e = completedDeal();
    const channel = sdkThread();
    const i = mockedInteraction(`admin_close_${e.id}`, moderator, channel);
    await adminClose.execute(i);
    const closure = transcriptRepository.getThreadClosure(e.id, channel.archiveTimestamp);
    assert.equal(closure.actor_discord_id, moderator.id);
    assert.equal(closure.actor_name, moderator.tag);
    assert.equal(closure.kind, 'moderator');
    assert.equal(closure.archive_timestamp, channel.archiveTimestamp);
    assert.equal(i.calls.editReply[0].components.length, 0);
});

test('joint approval records the participant who actually triggers the archive', async () => {
    const e = completedDeal();
    const channel = sdkThread();
    await approveClose.execute(mockedInteraction(`approve_close_${e.id}`, buyer, channel));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures').get().count, 0);
    await approveClose.execute(mockedInteraction(`approve_close_${e.id}`, seller, channel));
    const closure = transcriptRepository.getThreadClosure(e.id, channel.archiveTimestamp);
    assert.equal(closure.actor_discord_id, seller.id);
    assert.equal(closure.actor_name, seller.tag);
    assert.equal(closure.kind, 'participant');
});

test('failed participant closure keeps approvals and restores buttons for a later retry', async () => {
    const e = completedDeal();
    const channel = sdkThread();
    await approveClose.execute(mockedInteraction(`approve_close_${e.id}`, buyer, channel));
    const archive = channel.setArchived;
    channel.setArchived = async () => { throw new Error('Retryable archive failure'); };
    const failed = mockedInteraction(`approve_close_${e.id}`, seller, channel);
    await approveClose.execute(failed);
    const state = escrowRepository.getEscrowById(e.id);
    assert.equal(state.buyer_close_approved, 1);
    assert.equal(state.seller_close_approved, 1);
    assert.equal(failed.calls.editReply.at(-1).components[0].toJSON().components.length, 2);
    assert.equal(db.prepare('SELECT status FROM escrow_thread_closures').get().status, 'failed');
    assert.equal(failed.calls.send.some(text => /has been closed|was closed|closed this conversation/.test(text)), false);
    channel.setArchived = archive;
    await approveClose.execute(mockedInteraction(`approve_close_${e.id}`, buyer, channel));
    const closure = transcriptRepository.getThreadClosure(e.id, channel.archiveTimestamp);
    assert.equal(closure.actor_discord_id, buyer.id);
    assert.equal(closure.kind, 'participant');
});

test('handler preserves successful archive when metadata finalization fails', async () => {
    const e = completedDeal();
    const channel = sdkThread();
    const i = mockedInteraction(`admin_close_${e.id}`, moderator, channel);
    const record = transcriptRepository.recordThreadArchive;
    transcriptRepository.recordThreadArchive = () => { throw new Error('Metadata write failed'); };
    try {
        await adminClose.execute(i);
    } finally {
        transcriptRepository.recordThreadArchive = record;
    }
    assert.equal(channel.archived, true);
    assert.equal(i.calls.editReply.length, 1);
    assert.deepEqual(i.calls.editReply[0].components, []);
    assert.match(i.calls.followUp[0].content, /archived successfully/);
    assert.equal(db.prepare('SELECT status FROM escrow_thread_closures WHERE escrow_id = ?').get(e.id).status, 'pending');
    assert.equal(channel.calls.at(-1)[0], 'emit');
});
