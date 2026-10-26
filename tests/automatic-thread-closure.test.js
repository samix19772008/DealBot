process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { createEscrow, getEscrowById } = require('../src/database/escrowRepository');
const repository = require('../src/database/transcriptRepository');
const { closeDealThread } = require('../src/utils/threadClosure');
const { buildTranscriptSummary } = require('../src/utils/transcriptPresentation');

const bot = { id: 'bot', username: 'DealBot', bot: true };

beforeEach(() => db.exec('DELETE FROM escrow_thread_closures; DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users;'));
after(() => db.close());

function deal(status = 'completed') {
    const buyer = getOrCreateUser({ id: 'buyer', tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: 'seller', tag: 'Seller', createdAt: new Date('2020-01-01') });
    const escrow = createEscrow({ guildId: 'guild', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Game item', amount: 5, currency: 'USD' });
    db.prepare('UPDATE escrow_transactions SET status = ? WHERE id = ?').run(status, escrow.id);
    return getEscrowById(escrow.id);
}

function thread() {
    const calls = [];
    const channel = {
        archived: false, locked: false, calls,
        setLocked: async value => { calls.push(['lock', value]); channel.locked = value; return channel; },
        setArchived: async value => {
            calls.push(['archive', value]); channel.archived = value;
            channel.archiveTimestamp = Date.now(); return channel;
        },
    };
    return channel;
}

function options(channel, escrow, extra = {}) {
    return { channel, escrowId: escrow.id, actor: bot, kind: 'automatic', reason: 'Finished deal cleanup', ...extra };
}

test('automatic closure preserves the real bot identity and shows it in the transcript summary', async () => {
    const escrow = deal();
    const channel = thread();
    const result = await closeDealThread(options(channel, escrow));
    assert.equal(result.archived, true);
    assert.equal(result.closure.actor_discord_id, bot.id);
    assert.equal(result.closure.actor_name, 'DealBot (automatic cleanup)');
    assert.equal(result.closure.kind, 'untracked');
    assert.equal(result.closure.status, 'archived');
    const summary = buildTranscriptSummary({ escrow, closure: result.closure });
    const closedBy = summary.embeds[0].toJSON().fields.find(field => field.name === 'Closed By').value;
    assert.match(closedBy, /DealBot \(automatic cleanup\) : bot/);
    assert.doesNotMatch(closedBy, /Buyer|Seller/);
    assert.equal(repository.recordThreadArchive(escrow.id, result.archiveTimestamp).id, result.closure.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures').get().count, 1);
});

test('automatic requests are restricted to terminal deals and still validate the actor', () => {
    for (const status of ['pending', 'awaiting_payment', 'funded', 'delivered', 'disputed']) {
        const escrow = deal(status);
        assert.throws(() => repository.beginAutomaticThreadClosure(escrow.id, { actorId: bot.id }), /Only finished/);
    }
    for (const status of ['completed', 'cancelled', 'refunded']) {
        const escrow = deal(status);
        assert.throws(() => repository.beginAutomaticThreadClosure(escrow.id, { actorId: '' }), /must be recorded/);
        assert.throws(() => repository.beginAutomaticThreadClosure(escrow.id, { actorId: 'x'.repeat(129) }), /must be recorded/);
        const request = repository.beginAutomaticThreadClosure(escrow.id, { actorId: bot.id, actorName: 'Invented participant' });
        const row = db.prepare('SELECT * FROM escrow_thread_closures WHERE id = ?').get(request);
        assert.equal(row.kind, 'untracked');
        assert.equal(row.actor_name, 'DealBot (automatic cleanup)');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures').get().count, 3);
});

test('human requests cannot opt into an untracked or automatic kind', () => {
    const escrow = deal();
    for (const kind of ['automatic', 'untracked']) {
        assert.throws(() => repository.beginThreadClosure(escrow.id, { actorId: 'buyer', kind }), /participant or moderator/);
    }
});

test('the runtime automatic path requires a bot actor before making Discord changes', async () => {
    const escrow = deal();
    const channel = thread();
    await assert.rejects(closeDealThread(options(channel, escrow, { actor: { id: 'buyer' } })), /valid closure kind/);
    assert.deepEqual(channel.calls, []);
});

test('a stale cleanup decision before locking does not mutate the conversation', async () => {
    const escrow = deal();
    const channel = thread();
    const result = await closeDealThread(options(channel, escrow, { beforeArchive: async () => false }));
    assert.deepEqual(result, { archived: false, skipped: true });
    assert.deepEqual(channel.calls, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures').get().count, 0);
});

test('activity or policy changes while locking defer cleanup and restore its previous unlocked state', async () => {
    const escrow = deal();
    const channel = thread();
    let guards = 0;
    const result = await closeDealThread(options(channel, escrow, { beforeArchive: async () => ++guards === 1 }));
    assert.deepEqual(result, { archived: false, skipped: true });
    assert.equal(channel.locked, false);
    assert.equal(channel.archived, false);
    assert.deepEqual(channel.calls, [['lock', true], ['lock', false]]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures').get().count, 0);
});

test('deferring cleanup preserves an existing staff lock', async () => {
    const escrow = deal();
    const channel = thread();
    channel.locked = true;
    let guards = 0;
    await closeDealThread(options(channel, escrow, { beforeArchive: async () => ++guards === 1 }));
    assert.deepEqual(channel.calls, [['lock', true]]);
    assert.equal(channel.locked, true);
});

test('rollback cannot unlock a freshly archived thread using a stale unarchived cache', async () => {
    const escrow = deal();
    const channel = thread();
    const actual = { archived: true, locked: true, setLocked: async () => assert.fail('An existing archive must remain locked') };
    channel.fetch = async () => actual;
    let guards = 0;
    const result = await closeDealThread(options(channel, escrow, { beforeArchive: async () => ++guards === 1 }));
    assert.deepEqual(result, { archived: false, skipped: true });
    assert.deepEqual(channel.calls, [['lock', true]]);
    assert.equal(actual.locked, true);
});

test('rollback skips unlocking when a fresh thread observation is unavailable', async () => {
    const escrow = deal();
    const channel = thread();
    channel.fetch = async () => { throw new Error('Network unavailable'); };
    let guards = 0;
    await closeDealThread(options(channel, escrow, { beforeArchive: async () => ++guards === 1 }));
    assert.deepEqual(channel.calls, [['lock', true]]);
    assert.equal(channel.locked, true);
});

test('a post-lock guard failure restores the previous unlocked state and records no close request', async () => {
    const escrow = deal();
    const channel = thread();
    let guards = 0;
    await assert.rejects(closeDealThread(options(channel, escrow, { beforeArchive: async () => {
        if (++guards === 2) throw new Error('Fresh permissions unavailable');
        return true;
    } })), /Fresh permissions/);
    assert.equal(channel.locked, false);
    assert.equal(channel.archived, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures').get().count, 0);
});

test('a database state change at automatic request creation cannot leave an active deal locked', async () => {
    const escrow = deal();
    const channel = thread();
    channel.setLocked = async value => {
        channel.locked = value;
        if (value) db.prepare("UPDATE escrow_transactions SET status = 'disputed' WHERE id = ?").run(escrow.id);
        return channel;
    };
    await assert.rejects(closeDealThread(options(channel, escrow)), /Only finished/);
    assert.equal(channel.locked, false);
    assert.equal(channel.archived, false);
});

test('an interrupted automatic request is superseded and an unrelated old archive has no invented bot actor', async () => {
    const escrow = deal();
    const abandoned = repository.beginAutomaticThreadClosure(escrow.id, { actorId: 'old-bot' });
    const retry = repository.beginAutomaticThreadClosure(escrow.id, { actorId: bot.id });
    assert.equal(db.prepare('SELECT status FROM escrow_thread_closures WHERE id = ?').get(abandoned).status, 'failed');
    const archived = repository.recordThreadArchive(escrow.id, Date.now());
    assert.equal(archived.id, retry);
    assert.equal(archived.actor_discord_id, bot.id);
    const oldEscrow = deal();
    const channel = thread();
    channel.archived = true;
    channel.archiveTimestamp = Date.now() - 10_000;
    const result = await closeDealThread(options(channel, oldEscrow));
    assert.equal(result.alreadyArchived, true);
    assert.equal(result.closure.actor_discord_id, null);
    assert.deepEqual(channel.calls, []);
});

test('a lost archive response retains the automatic bot identity after a fresh archive observation', async () => {
    const escrow = deal();
    const channel = thread();
    channel.setArchived = async () => {
        channel.archived = true;
        channel.archiveTimestamp = Date.now();
        throw new Error('HTTP response lost');
    };
    channel.fetch = async () => channel;
    const result = await closeDealThread(options(channel, escrow));
    assert.equal(result.archived, true);
    assert.equal(result.closure.actor_discord_id, bot.id);
    assert.equal(result.closure.actor_name, 'DealBot (automatic cleanup)');
});
