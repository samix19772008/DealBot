const { randomUUID } = require('node:crypto');

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const GENERATION_ATTEMPTS = 5;
const DELIVERY_ATTEMPTS = 12;
const LEASE_MS = 10 * 60 * 1000;
const RETRY_DELAYS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000];

function retryAt(attempt, now) {
    return now + RETRY_DELAYS[Math.min(Math.max(0, attempt - 1), RETRY_DELAYS.length - 1)];
}

function validTime(now) {
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 86_400_000) {
        throw new Error('A valid transcript processing timestamp is required.');
    }
    return now;
}

function errorCode(error) {
    const value = error?.code ?? error?.name ?? 'UnknownError';
    return String(value).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100) || 'UnknownError';
}

/** Keep archive artifacts and independent recipient progress in the same backup-able database. */
function createTranscriptDeliveryRepository({ database = require('./init').db, clock = Date.now } = {}) {
    const archiveById = database.prepare('SELECT * FROM transcript_delivery_archives WHERE id = ?');
    const recipientById = database.prepare('SELECT * FROM transcript_delivery_recipients WHERE id = ?');
    const enqueue = database.transaction(({ escrow, closure, summary = {}, readySummary = {}, filename, now = clock() }) => {
        const at = validTime(now);
        if (!escrow?.id || closure?.escrow_id !== escrow.id || closure.status !== 'archived' ||
            !Number.isSafeInteger(closure.archive_timestamp) || closure.archive_timestamp <= 0 || !escrow.channel_id) {
            throw new Error('A persisted archived deal is required before transcript delivery.');
        }
        const existing = database.prepare('SELECT * FROM transcript_delivery_archives WHERE escrow_id = ? AND archive_timestamp = ?')
            .get(escrow.id, closure.archive_timestamp);
        if (existing) {
            if (existing.summary_json === '{}' && Object.keys(summary).length) enrichArchive(existing.id, { summary, readySummary });
            return archiveById.get(existing.id);
        }
        filename ||= require('../utils/transcriptPresentation').transcriptFilename(escrow);
        const summaryJson = JSON.stringify(summary);
        const readyJson = JSON.stringify(readySummary);
        if (summaryJson.length > 20000 || readyJson.length > 20000 || !/^[A-Za-z0-9-]+\.html$/.test(filename)) {
            throw new Error('The transcript summary or filename is invalid.');
        }
        const escrowSnapshot = Object.fromEntries([
            'id', 'transaction_uuid', 'guild_id', 'channel_id', 'item_description', 'status', 'amount',
            'currency', 'payment_unit', 'buyer_discord_id', 'buyer_username', 'seller_discord_id', 'seller_username',
        ].map(key => [key, escrow[key]]));
        const closureSnapshot = Object.fromEntries([
            'id', 'escrow_id', 'actor_discord_id', 'actor_name', 'kind', 'status', 'archive_timestamp',
        ].map(key => [key, closure[key]]));
        const result = database.prepare(`INSERT INTO transcript_delivery_archives
            (escrow_id, closure_id, guild_id, thread_id, archive_timestamp, escrow_json, closure_json, summary_json, ready_summary_json,
             filename, generation_next_attempt, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(escrow.id, closure.id, escrow.guild_id,
            escrow.channel_id, closure.archive_timestamp, JSON.stringify(escrowSnapshot), JSON.stringify(closureSnapshot), summaryJson, readyJson, filename, at, at, at);
        for (const recipient of new Set([escrow.buyer_discord_id, escrow.seller_discord_id])) {
            if (typeof recipient !== 'string' || !recipient.trim()) throw new Error('Both transcript recipients must be recorded.');
            database.prepare(`INSERT INTO transcript_delivery_recipients
                (archive_id, recipient_id, next_attempt, updated_at) VALUES (?, ?, ?, ?)`)
                .run(result.lastInsertRowid, recipient, at, at);
        }
        return archiveById.get(result.lastInsertRowid);
    });

    function enrichArchive(archiveId, { summary, readySummary }) {
        const summaryJson = JSON.stringify(summary);
        const readyJson = JSON.stringify(readySummary);
        if (summaryJson.length > 20000 || readyJson.length > 20000) throw new Error('The transcript summary is too large.');
        database.prepare(`UPDATE transcript_delivery_archives SET summary_json = ?, ready_summary_json = ?
            WHERE id = ? AND summary_json = '{}'`).run(summaryJson, readyJson, archiveId);
        return archiveById.get(archiveId);
    }

    const claimGeneration = database.transaction((archiveId, now = clock()) => {
        const at = validTime(now);
        const token = randomUUID();
        const result = database.prepare(`UPDATE transcript_delivery_archives SET generation_lease_token = ?,
            generation_lease_until = ?, generation_attempts = generation_attempts + 1, updated_at = ?
            WHERE id = ? AND generation_status = 'pending' AND generation_next_attempt <= ?
              AND (generation_lease_until IS NULL OR generation_lease_until <= ?)
              AND generation_attempts < ?`).run(token, at + LEASE_MS, at, archiveId, at, at, GENERATION_ATTEMPTS);
        return result.changes ? archiveById.get(archiveId) : null;
    });

    const claimRecipient = database.transaction((recipientId, now = clock()) => {
        const at = validTime(now);
        const token = randomUUID();
        const result = database.prepare(`UPDATE transcript_delivery_recipients SET lease_token = ?, lease_until = ?,
            attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND next_attempt <= ?
              AND (lease_until IS NULL OR lease_until <= ?) AND attempts < ?
              AND EXISTS (SELECT 1 FROM transcript_delivery_archives a WHERE a.id = archive_id
                AND (summary_delivered = 0 OR a.generation_status IN ('ready', 'unavailable'))
                AND (a.generation_status != 'pending' OR (a.generation_attempts > 0 AND
                    (a.generation_lease_until IS NULL OR a.generation_lease_until <= ?))))`)
            .run(token, at + LEASE_MS, at, recipientId, at, at, DELIVERY_ATTEMPTS, at);
        if (!result.changes) return null;
        const recipient = recipientById.get(recipientId);
        const archive = archiveById.get(recipient.archive_id);
        return { ...recipient, archive,
            mode: archive.generation_status === 'ready' ? (recipient.summary_delivered ? 'html' : 'full') : 'summary' };
    });

    function finishGeneration(job, { html = null, error = null, unavailable = false, now = clock() } = {}) {
        const at = validTime(now);
        if (html != null && (!Buffer.isBuffer(html) || html.length === 0 || html.length > MAX_TRANSCRIPT_BYTES)) {
            throw new Error('The transcript artifact must be a nonempty buffer of at most 8 MiB.');
        }
        const state = html ? 'ready' : unavailable || job.generation_attempts >= GENERATION_ATTEMPTS ? 'unavailable' : 'pending';
        const result = database.prepare(`UPDATE transcript_delivery_archives SET html = ?, generation_status = ?,
            generation_next_attempt = ?, generation_lease_token = NULL, generation_lease_until = NULL,
            generation_error = ?, updated_at = ? WHERE id = ? AND generation_lease_token = ?`)
            .run(html, state, state === 'pending' ? retryAt(job.generation_attempts, at) : at,
                error ? errorCode(error) : null, at, job.id, job.generation_lease_token);
        return result.changes > 0;
    }

    function finishRecipient(job, { messageId = null, error = null, now = clock() } = {}) {
        const at = validTime(now);
        if (error) {
            return database.prepare(`UPDATE transcript_delivery_recipients SET status = ?, next_attempt = ?,
                lease_token = NULL, lease_until = NULL, last_error = ?, updated_at = ?
                WHERE id = ? AND lease_token = ?`).run(job.attempts >= DELIVERY_ATTEMPTS ? 'exhausted' : 'pending',
                retryAt(job.attempts, at), errorCode(error), at, job.id, job.lease_token).changes > 0;
        }
        const summaryDelivered = job.summary_delivered || job.mode !== 'html' ? 1 : 0;
        const htmlDelivered = job.html_delivered || job.mode !== 'summary' ? 1 : 0;
        const final = htmlDelivered || job.archive.generation_status === 'unavailable';
        const status = final ? 'delivered' : job.attempts >= DELIVERY_ATTEMPTS ? 'exhausted' : 'pending';
        return database.prepare(`UPDATE transcript_delivery_recipients SET summary_delivered = ?, html_delivered = ?,
            status = ?, next_attempt = ?, lease_token = NULL, lease_until = NULL, last_error = NULL,
            last_message_id = ?, updated_at = ? WHERE id = ? AND lease_token = ?`)
            .run(summaryDelivered, htmlDelivered, status, at,
                messageId == null ? null : String(messageId).slice(0, 30), at, job.id, job.lease_token).changes > 0;
    }

    function recoverExpiredClaims(now = clock()) {
        const at = validTime(now);
        // A worker can stop during its final attempt before recording an outcome.
        database.prepare(`UPDATE transcript_delivery_archives SET generation_status = 'unavailable',
            generation_lease_token = NULL, generation_lease_until = NULL, generation_error = 'AttemptsExhausted', updated_at = ?
            WHERE generation_status = 'pending' AND generation_attempts >= ?
              AND (generation_lease_until IS NULL OR generation_lease_until <= ?)`)
            .run(at, GENERATION_ATTEMPTS, at);
        database.prepare(`UPDATE transcript_delivery_recipients SET status = 'exhausted', lease_token = NULL,
            lease_until = NULL, last_error = 'AttemptsExhausted', updated_at = ?
            WHERE status = 'pending' AND attempts >= ? AND (lease_until IS NULL OR lease_until <= ?)`)
            .run(at, DELIVERY_ATTEMPTS, at);
        database.prepare(`UPDATE transcript_delivery_recipients SET status = 'delivered', updated_at = ?
            WHERE status = 'pending' AND summary_delivered = 1 AND (lease_until IS NULL OR lease_until <= ?)
            AND EXISTS (SELECT 1 FROM transcript_delivery_archives a WHERE a.id = archive_id AND a.generation_status = 'unavailable')`)
            .run(at, at);
    }

    function dueArchives({ limit = 5, now = clock() } = {}) {
        const at = validTime(now);
        recoverExpiredClaims(at);
        return database.prepare(`SELECT id FROM transcript_delivery_archives
            WHERE generation_status = 'pending' AND generation_next_attempt <= ?
              AND (generation_lease_until IS NULL OR generation_lease_until <= ?) AND generation_attempts < ?
            ORDER BY generation_next_attempt, id LIMIT ?`).all(at, at, GENERATION_ATTEMPTS, Math.min(20, Math.max(1, limit))).map(row => row.id);
    }

    function dueRecipients({ archiveId, limit = 20, now = clock() } = {}) {
        const at = validTime(now);
        recoverExpiredClaims(at);
        return database.prepare(`SELECT r.id FROM transcript_delivery_recipients r JOIN transcript_delivery_archives a ON a.id = r.archive_id
            WHERE r.status = 'pending' AND r.next_attempt <= ? AND (r.lease_until IS NULL OR r.lease_until <= ?)
              AND r.attempts < ? AND (? IS NULL OR r.archive_id = ?)
              AND (r.summary_delivered = 0 OR a.generation_status IN ('ready', 'unavailable'))
              AND (a.generation_status != 'pending' OR (a.generation_attempts > 0 AND
                (a.generation_lease_until IS NULL OR a.generation_lease_until <= ?)))
            ORDER BY r.next_attempt, r.id LIMIT ?`).all(at, at, DELIVERY_ATTEMPTS,
                archiveId ?? null, archiveId ?? null, at, Math.min(100, Math.max(1, limit))).map(row => row.id);
    }

    function renewGeneration(job, now = clock()) {
        return database.prepare(`UPDATE transcript_delivery_archives SET generation_lease_until = ?
            WHERE id = ? AND generation_lease_token = ? AND generation_status = 'pending'`)
            .run(validTime(now) + LEASE_MS, job.id, job.generation_lease_token).changes > 0;
    }
    function renewRecipient(job, now = clock()) {
        return database.prepare(`UPDATE transcript_delivery_recipients SET lease_until = ?
            WHERE id = ? AND lease_token = ? AND status = 'pending'`)
            .run(validTime(now) + LEASE_MS, job.id, job.lease_token).changes > 0;
    }

    function releaseGeneration(job, now = clock()) {
        return database.prepare(`UPDATE transcript_delivery_archives SET generation_lease_token = NULL,
            generation_lease_until = NULL, generation_attempts = MAX(0, generation_attempts - 1), updated_at = ?
            WHERE id = ? AND generation_lease_token = ? AND generation_status = 'pending'`)
            .run(validTime(now), job.id, job.generation_lease_token).changes > 0;
    }
    function releaseRecipient(job, now = clock()) {
        return database.prepare(`UPDATE transcript_delivery_recipients SET lease_token = NULL,
            lease_until = NULL, attempts = MAX(0, attempts - 1), updated_at = ?
            WHERE id = ? AND lease_token = ? AND status = 'pending'`)
            .run(validTime(now), job.id, job.lease_token).changes > 0;
    }

    function recipients(archiveId) {
        return database.prepare('SELECT * FROM transcript_delivery_recipients WHERE archive_id = ? ORDER BY id').all(archiveId);
    }
    function getStats(guildId) {
        return database.prepare(`SELECT r.status, COUNT(*) AS count FROM transcript_delivery_recipients r
            JOIN transcript_delivery_archives a ON a.id = r.archive_id WHERE (? IS NULL OR a.guild_id = ?)
            GROUP BY r.status`).all(guildId ?? null, guildId ?? null);
    }

    function getQueueStats() {
        const counts = database.prepare(`SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingRecipients,
            SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS failedRecipients
            FROM transcript_delivery_recipients`).get();
        const archives = database.prepare("SELECT COUNT(*) AS count FROM transcript_delivery_archives WHERE generation_status = 'pending'").get();
        return { pendingRecipients: counts.pendingRecipients || 0,
            failedRecipients: counts.failedRecipients || 0, pendingArchives: archives.count };
    }

    return { enqueue: options => enqueue.immediate(options), enrichArchive, getArchive: id => archiveById.get(id),
        claimGeneration: (id, now) => claimGeneration.immediate(id, now), finishGeneration,
        claimRecipient: (id, now) => claimRecipient.immediate(id, now), finishRecipient,
        dueArchives, dueRecipients, renewGeneration, renewRecipient, releaseGeneration, releaseRecipient,
        recipients, getStats, getQueueStats };
}

module.exports = { createTranscriptDeliveryRepository, MAX_TRANSCRIPT_BYTES, GENERATION_ATTEMPTS,
    DELIVERY_ATTEMPTS, LEASE_MS, RETRY_DELAYS, errorCode };
