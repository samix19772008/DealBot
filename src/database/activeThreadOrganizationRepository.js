const { randomUUID } = require('node:crypto');
const { db } = require('./init');
const { getEscrowById } = require('./escrowRepository');
const { getActiveThreadIdleMinutes } = require('./guildSettingsRepository');

const LEASE_MS = 120_000;
const ELIGIBLE = new Set(['awaiting_payment', 'funded', 'delivered']);
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value = Date.now()) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - MAX_DELAY_MS) {
        throw new Error('A valid active-chat idle timestamp is required.');
    }
    return value;
}

function failureCode(value) {
    return String(value?.code ?? value?.name ?? value ?? 'UnknownError')
        .replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100) || 'UnknownError';
}

function seedActiveThreadCleanupJobs({ now = Date.now() } = {}) {
    const at = timestamp(now);
    const result = db.prepare(`INSERT OR IGNORE INTO deal_active_thread_cleanup(escrow_id, due_at, updated_at)
        SELECT e.id,
            MAX(0, COALESCE(CAST(strftime('%s', e.updated_at) AS INTEGER) * 1000
                + CAST(substr(strftime('%f', e.updated_at), 4, 3) AS INTEGER), ?))
                + COALESCE(g.active_thread_idle_minutes, 15) * 60000,
            ?
        FROM escrow_transactions e LEFT JOIN guild_settings g ON g.guild_id = e.guild_id
        WHERE e.status IN ('awaiting_payment', 'funded', 'delivered') AND e.channel_id IS NOT NULL
            AND e.channel_id != '' AND COALESCE(g.active_thread_idle_minutes, 15) > 0`).run(at, at);
    return result.changes;
}

const claimJobs = db.transaction(({ limit = 5, now = Date.now() } = {}) => {
    const at = timestamp(now);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Choose a cleanup batch size from 1 to 20.');
    const candidates = db.prepare(`SELECT j.escrow_id FROM deal_active_thread_cleanup j
        JOIN escrow_transactions e ON e.id = j.escrow_id
        LEFT JOIN guild_settings g ON g.guild_id = e.guild_id
        WHERE j.status = 'pending' AND j.due_at <= ?
            AND (j.lease_until IS NULL OR j.lease_until <= ?)
            AND e.status IN ('awaiting_payment', 'funded', 'delivered')
            AND e.channel_id IS NOT NULL AND e.channel_id != ''
            AND COALESCE(g.active_thread_idle_minutes, 15) > 0
        ORDER BY j.due_at, j.escrow_id LIMIT ?`).all(at, at, limit);
    const jobs = [];
    for (const candidate of candidates) {
        const token = randomUUID();
        const claimed = db.prepare(`UPDATE deal_active_thread_cleanup SET lease_token = ?, lease_until = ?,
            attempts = attempts + 1, updated_at = ? WHERE escrow_id = ? AND status = 'pending'
            AND due_at <= ? AND (lease_until IS NULL OR lease_until <= ?)`)
            .run(token, at + LEASE_MS, at, candidate.escrow_id, at, at);
        if (!claimed.changes) continue;
        const job = db.prepare('SELECT * FROM deal_active_thread_cleanup WHERE escrow_id = ?').get(candidate.escrow_id);
        const escrow = getEscrowById(job.escrow_id);
        jobs.push({ ...job, escrow, idleMinutes: getActiveThreadIdleMinutes(escrow.guild_id) });
    }
    return jobs;
});

function claimActiveThreadCleanupJobs(options) { return claimJobs.immediate(options); }

function ownsActiveThreadCleanup(job, { now = Date.now() } = {}) {
    const at = timestamp(now);
    if (!job?.lease_token || !job.escrow_id) return false;
    return Boolean(db.prepare(`SELECT 1 FROM deal_active_thread_cleanup WHERE escrow_id = ? AND status = 'pending'
        AND lease_token = ? AND lease_until > ?`).get(job.escrow_id, job.lease_token, at));
}

function deferActiveThreadCleanup(job, { dueAt, now = Date.now() } = {}) {
    const at = timestamp(now);
    const due = timestamp(dueAt);
    if (due < at) throw new Error('A deferred cleanup must not be scheduled in the past.');
    if (!job?.lease_token) return false;
    return db.prepare(`UPDATE deal_active_thread_cleanup SET due_at = ?, lease_token = NULL, lease_until = NULL,
        updated_at = ? WHERE escrow_id = ? AND lease_token = ? AND status = 'pending' AND lease_until > ?`)
        .run(due, at, job.escrow_id, job.lease_token, at).changes > 0;
}

function failActiveThreadCleanup(job, { errorCode, now = Date.now() } = {}) {
    const at = timestamp(now);
    if (!job?.lease_token) return false;
    const delay = Math.min(MAX_DELAY_MS, 60_000 * (2 ** Math.min(Math.max(0, job.attempts - 1), 11)));
    return db.prepare(`UPDATE deal_active_thread_cleanup SET due_at = ?, lease_token = NULL, lease_until = NULL,
        last_error = ?, updated_at = ? WHERE escrow_id = ? AND lease_token = ? AND status = 'pending' AND lease_until > ?`)
        .run(at + delay, failureCode(errorCode), at, job.escrow_id, job.lease_token, at).changes > 0;
}

const finishJob = db.transaction((job, { archiveTimestamp = null, status = 'archived', automatic = false,
    actorId, reason = 'Active conversation hidden after inactivity; deal remains active', now = Date.now() } = {}) => {
    const at = timestamp(now);
    if (!['archived', 'unavailable'].includes(status)) throw new Error('A cleanup outcome must be archived or unavailable.');
    if (status === 'archived' && (!Number.isSafeInteger(archiveTimestamp) || archiveTimestamp <= 0 || !Number.isFinite(new Date(archiveTimestamp).getTime()))) {
        throw new Error('An actual archive timestamp is required for a hidden conversation.');
    }
    if (automatic && (status !== 'archived' || typeof actorId !== 'string' || !actorId.trim() || actorId.length > 128 ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 1000)) {
        throw new Error('An automatic archive must record its bot actor and reason.');
    }
    const escrow = getEscrowById(job?.escrow_id);
    if (!escrow || !ELIGIBLE.has(escrow.status) || !escrow.channel_id || getActiveThreadIdleMinutes(escrow.guild_id) === 0 ||
        (job?.escrow && (job.escrow.channel_id !== escrow.channel_id || job.escrow.guild_id !== escrow.guild_id)) ||
        !ownsActiveThreadCleanup(job, { now: at })) return false;
    const updated = db.prepare(`UPDATE deal_active_thread_cleanup SET status = ?, archived_timestamp = ?,
        lease_token = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
        WHERE escrow_id = ? AND lease_token = ? AND status = 'pending' AND lease_until > ?`)
        .run(status, status === 'archived' ? archiveTimestamp : null, at, escrow.id, job.lease_token, at);
    if (!updated.changes) return false;
    if (automatic) {
        db.prepare(`INSERT INTO escrow_events(escrow_id,event_type,from_status,to_status,actor_discord_id,reason)
            VALUES (?, 'thread_idle_archived', ?, ?, ?, ?)`).run(escrow.id, escrow.status, escrow.status, actorId.trim(), reason.trim());
    }
    return true;
});

function finishActiveThreadCleanup(job, options) { return finishJob.immediate(job, options); }

function rescheduleActiveThreadCleanup(escrowId, { now = Date.now() } = {}) {
    const at = timestamp(now);
    const escrow = getEscrowById(escrowId);
    if (!escrow || !escrow.channel_id || !ELIGIBLE.has(escrow.status)) return false;
    const dueAt = at + getActiveThreadIdleMinutes(escrow.guild_id) * 60_000;
    db.prepare(`INSERT INTO deal_active_thread_cleanup(escrow_id,due_at,updated_at) VALUES (?, ?, ?)
        ON CONFLICT(escrow_id) DO UPDATE SET due_at = excluded.due_at, status = 'pending',
            lease_token = NULL, lease_until = NULL, attempts = 0, last_error = NULL,
            archived_timestamp = NULL, updated_at = excluded.updated_at`).run(escrow.id, dueAt, at);
    return true;
}

module.exports = { LEASE_MS, seedActiveThreadCleanupJobs, claimActiveThreadCleanupJobs, ownsActiveThreadCleanup,
    deferActiveThreadCleanup, failActiveThreadCleanup, finishActiveThreadCleanup, rescheduleActiveThreadCleanup };
