process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, initDatabase } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { createEscrow } = require('../src/database/escrowRepository');
const {
    beginThreadClosure, failThreadClosure, recordThreadArchive, getThreadClosure, markThreadReopened,
} = require('../src/database/transcriptRepository');

function deal() {
    const buyer = getOrCreateUser({ id: 'buyer', tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: 'seller', tag: 'Seller', createdAt: new Date('2020-01-01') });
    return createEscrow({ guildId: 'guild', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'An item', amount: 10, currency: 'USD' });
}
function row(id) { return db.prepare('SELECT * FROM escrow_thread_closures WHERE id = ?').get(id); }
function rows() { return db.prepare('SELECT * FROM escrow_thread_closures ORDER BY id').all(); }

beforeEach(() => {
    db.exec('DELETE FROM escrow_thread_closures; DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users;');
});
after(() => db.close());

test('recording a close request alone does not claim that the thread was archived', () => {
    const escrow = deal();
    const request = beginThreadClosure(escrow.id, { actorId: 'buyer', actorName: 'Buyer', kind: 'participant' });
    assert.equal(row(request).status, 'pending');
    assert.equal(row(request).archive_timestamp, null);
    assert.equal(getThreadClosure(escrow.id, Date.now()), undefined);
});

test('a failed archive is excluded from closer attribution and a successful retry gets its own identity', () => {
    const escrow = deal();
    const failed = beginThreadClosure(escrow.id, { actorId: 'buyer', actorName: 'Buyer', kind: 'participant' });
    assert.equal(failThreadClosure(failed), true);
    assert.equal(failThreadClosure(failed), false);
    const retry = beginThreadClosure(escrow.id, { actorId: 'staff', actorName: 'Moderator', kind: 'moderator' });
    const timestamp = Date.now();
    const closed = recordThreadArchive(escrow.id, timestamp);
    assert.equal(closed.id, retry);
    assert.equal(closed.actor_discord_id, 'staff');
    assert.equal(closed.kind, 'moderator');
    assert.equal(row(failed).status, 'failed');
});

test('Gateway-first and API-first observations of the same archive bind once and cannot be marked failed later', () => {
    const escrow = deal();
    const request = beginThreadClosure(escrow.id, { actorId: 'seller', actorName: 'Seller', kind: 'participant' });
    const timestamp = Date.now();
    const gateway = recordThreadArchive(escrow.id, timestamp);
    assert.equal(gateway.id, request);
    assert.equal(gateway.status, 'archived');
    assert.equal(failThreadClosure(request), false);
    const api = recordThreadArchive(escrow.id, timestamp);
    assert.deepEqual(api, gateway);
    assert.deepEqual(getThreadClosure(escrow.id, timestamp), gateway);
    assert.equal(rows().length, 1);
});

test('an automatic or externally triggered archive has no invented closer', () => {
    const escrow = deal();
    const timestamp = Date.now();
    const closure = recordThreadArchive(escrow.id, timestamp);
    assert.equal(closure.kind, 'untracked');
    assert.equal(closure.status, 'archived');
    assert.equal(closure.actor_discord_id, null);
    assert.equal(closure.actor_name, null);
    assert.equal(closure.archive_timestamp, timestamp);
    assert.equal(recordThreadArchive(escrow.id, timestamp).id, closure.id);
});

test('reopening and archiving again never reuses the previous closer', () => {
    const escrow = deal();
    beginThreadClosure(escrow.id, { actorId: 'buyer', actorName: 'Buyer', kind: 'participant' });
    const firstTimestamp = Date.now();
    const first = recordThreadArchive(escrow.id, firstTimestamp);
    markThreadReopened(escrow.id);
    const second = recordThreadArchive(escrow.id, firstTimestamp + 1);
    assert.notEqual(first.id, second.id);
    assert.equal(first.actor_discord_id, 'buyer');
    assert.equal(second.actor_discord_id, null);
    assert.equal(second.kind, 'untracked');
    assert.equal(rows().length, 2);
});

test('a reopen invalidates an orphan request before a later manual archive', () => {
    const escrow = deal();
    const request = beginThreadClosure(escrow.id, { actorId: 'buyer', kind: 'participant' });
    assert.equal(markThreadReopened(escrow.id), 1);
    const closure = recordThreadArchive(escrow.id, Date.now());
    assert.equal(row(request).status, 'failed');
    assert.equal(closure.kind, 'untracked');
    assert.equal(closure.actor_discord_id, null);
});

test('stale pending requests expire and cannot identify an unrelated archive', () => {
    const escrow = deal();
    const request = beginThreadClosure(escrow.id, { actorId: 'staff', actorName: 'Moderator', kind: 'moderator' });
    db.prepare("UPDATE escrow_thread_closures SET requested_at = datetime('now', '-6 minutes') WHERE id = ?").run(request);
    const closure = recordThreadArchive(escrow.id, Date.now());
    assert.notEqual(closure.id, request);
    assert.equal(closure.kind, 'untracked');
    assert.equal(closure.actor_discord_id, null);
});

test('a delayed older archive event does not consume a newer in-flight close request', () => {
    const escrow = deal();
    const oldTimestamp = Date.now() - 10;
    const request = beginThreadClosure(escrow.id, { actorId: 'staff', actorName: 'Moderator', kind: 'moderator' });
    const oldArchive = recordThreadArchive(escrow.id, oldTimestamp);
    assert.equal(oldArchive.kind, 'untracked');
    assert.equal(row(request).status, 'pending');
    const currentArchive = recordThreadArchive(escrow.id, Date.now());
    assert.equal(currentArchive.id, request);
    assert.equal(currentArchive.actor_discord_id, 'staff');
});

test('a retried pending request supersedes the interrupted attempt without overwriting archived evidence', () => {
    const escrow = deal();
    const abandoned = beginThreadClosure(escrow.id, { actorId: 'buyer', kind: 'participant' });
    const current = beginThreadClosure(escrow.id, { actorId: 'seller', actorName: 'Seller', kind: 'participant' });
    assert.equal(row(abandoned).status, 'failed');
    assert.equal(row(current).status, 'pending');
    const closure = recordThreadArchive(escrow.id, Date.now());
    assert.equal(closure.id, current);
    assert.equal(closure.actor_discord_id, 'seller');
    initDatabase();
    assert.deepEqual(getThreadClosure(escrow.id, closure.archive_timestamp), closure);
});

test('closure metadata is isolated by deal and invalid identities or timestamps write nothing', () => {
    const escrow = deal();
    const other = deal();
    beginThreadClosure(escrow.id, { actorId: 'buyer', kind: 'participant' });
    const timestamp = Date.now();
    const own = recordThreadArchive(escrow.id, timestamp);
    const foreign = recordThreadArchive(other.id, timestamp);
    assert.equal(own.actor_discord_id, 'buyer');
    assert.equal(foreign.actor_discord_id, null);
    const count = rows().length;
    assert.throws(() => beginThreadClosure(escrow.id, { actorId: 'stranger', kind: 'participant' }));
    assert.throws(() => beginThreadClosure(escrow.id, { actorId: 'staff', kind: 'system' }));
    assert.throws(() => beginThreadClosure(escrow.id, { actorId: null, kind: 'moderator' }));
    for (const invalid of [0, -1, NaN, Infinity, null, '2026-10-24', 1.5]) {
        assert.throws(() => recordThreadArchive(escrow.id, invalid));
    }
    assert.equal(rows().length, count);
});
