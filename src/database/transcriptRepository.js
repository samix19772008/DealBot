const { db } = require('./init');
const { getEscrowById } = require('./escrowRepository');

const PENDING_WINDOW_MS = 5 * 60 * 1000;
// Match conservatively: an archive must not be attributed to a request made
// after it. If clock skew prevents a match, leave the closer untracked.

const findArchive = db.prepare(`SELECT * FROM escrow_thread_closures
    WHERE escrow_id = ? AND archive_timestamp = ?`);
const findById = db.prepare('SELECT * FROM escrow_thread_closures WHERE id = ?');

function requireEscrow(escrowId) {
    const escrow = getEscrowById(escrowId);
    if (!escrow) throw new Error('This deal no longer exists.');
    return escrow;
}

function validArchiveTimestamp(timestamp) {
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime())) {
        throw new Error('An actual Discord archive timestamp in milliseconds is required.');
    }
}

/** Call only after locking succeeds and immediately before requesting archive. */
const beginClosure = db.transaction((escrowId, { actorId, actorName, kind = 'participant' } = {}) => {
    const escrow = requireEscrow(escrowId);
    if (!['participant', 'moderator'].includes(kind)) throw new Error('A tracked closure must be initiated by a participant or moderator.');
    if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > 128) {
        throw new Error('The user requesting closure must be recorded.');
    }
    if (kind === 'participant' && ![escrow.buyer_discord_id, escrow.seller_discord_id].includes(actorId)) {
        throw new Error('Only deal participants can request a participant closure.');
    }
    if (actorName != null && (typeof actorName !== 'string' || actorName.length > 128)) {
        throw new Error('The closer name must contain no more than 128 characters.');
    }
    // A newer attempt supersedes incomplete earlier attempts, including retries
    // after a process interruption. Never reuse those identities on a reopen.
    db.prepare("UPDATE escrow_thread_closures SET status = 'failed' WHERE escrow_id = ? AND status = 'pending'")
        .run(escrow.id);
    return Number(db.prepare(`INSERT INTO escrow_thread_closures
        (escrow_id, actor_discord_id, actor_name, kind) VALUES (?, ?, ?, ?)`)
        .run(escrow.id, actorId.trim(), actorName?.trim() || null, kind).lastInsertRowid);
});

function beginThreadClosure(escrowId, options) { return beginClosure.immediate(escrowId, options); }

/** A late API failure must not overwrite a Gateway-confirmed archive. */
function failThreadClosure(requestId) {
    if (!Number.isSafeInteger(requestId) || requestId <= 0) return false;
    return db.prepare("UPDATE escrow_thread_closures SET status = 'failed' WHERE id = ? AND status = 'pending'")
        .run(requestId).changes > 0;
}

/** Bind the same API/Gateway archive observation once, whichever arrives first. */
const recordArchive = db.transaction((escrowId, timestamp) => {
    validArchiveTimestamp(timestamp);
    const escrow = requireEscrow(escrowId);
    const existing = findArchive.get(escrow.id, timestamp);
    if (existing) return existing;
    const now = Date.now();
    const pending = db.prepare(`SELECT * FROM escrow_thread_closures
        WHERE escrow_id = ? AND status = 'pending' ORDER BY id DESC`).all(escrow.id)
        .find(request => {
            const requestedAt = Date.parse(`${request.requested_at.replace(' ', 'T')}Z`);
            return Number.isFinite(requestedAt) &&
                requestedAt >= now - PENDING_WINDOW_MS && requestedAt <= now &&
                requestedAt >= timestamp - PENDING_WINDOW_MS && requestedAt <= timestamp;
        });
    if (pending) {
        db.prepare("UPDATE escrow_thread_closures SET status = 'archived', archive_timestamp = ? WHERE id = ? AND status = 'pending'")
            .run(timestamp, pending.id);
        // Any obsolete pending requests are no longer candidates for a future
        // archival after the thread is reopened.
        db.prepare("UPDATE escrow_thread_closures SET status = 'failed' WHERE escrow_id = ? AND status = 'pending'")
            .run(escrow.id);
        return findById.get(pending.id);
    }
    const id = db.prepare(`INSERT INTO escrow_thread_closures
        (escrow_id, kind, status, archive_timestamp) VALUES (?, 'untracked', 'archived', ?)`)
        .run(escrow.id, timestamp).lastInsertRowid;
    return findById.get(id);
});

/** Reopening proves that an unfinished earlier close must not identify a later archive. */
function markThreadReopened(escrowId) {
    const escrow = getEscrowById(escrowId);
    if (!escrow) return 0;
    return db.prepare("UPDATE escrow_thread_closures SET status = 'failed' WHERE escrow_id = ? AND status = 'pending'")
        .run(escrow.id).changes;
}

function recordThreadArchive(escrowId, archiveTimestampMs) {
    return recordArchive.immediate(escrowId, archiveTimestampMs);
}

function getThreadClosure(escrowId, archiveTimestampMs) {
    validArchiveTimestamp(archiveTimestampMs);
    const escrow = getEscrowById(escrowId);
    return escrow ? findArchive.get(escrow.id, archiveTimestampMs) : undefined;
}

module.exports = { beginThreadClosure, failThreadClosure, recordThreadArchive, getThreadClosure, markThreadReopened };
