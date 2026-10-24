const { db } = require('./init');

const OFFER_COOLDOWN_MS = 15 * 1000;
const PENDING_OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_DEALS = 10;
const ACTIVE_STATUSES = ['pending', 'awaiting_payment', 'funded', 'delivered', 'disputed'];
const EXPIRY_REASON = 'Offer expired after 24 hours without seller acceptance.';

// Cooldowns are persisted so a process restart cannot reset request limits.
// This additive table is independent of the existing transaction status CHECK.
db.exec(`CREATE TABLE IF NOT EXISTS offer_cooldowns (
    guild_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_id)
)`);

function checkedIdentity(value, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > 128) {
        throw new Error(`A valid ${label} is required for offer policy checks.`);
    }
    return value.trim();
}

function checkedNow(value) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
        throw new Error('Offer policy time must be a valid timestamp in milliseconds.');
    }
    return value;
}

const findCooldown = db.prepare('SELECT acquired_at FROM offer_cooldowns WHERE guild_id = ? AND discord_id = ?');
const saveCooldown = db.prepare(`INSERT INTO offer_cooldowns (guild_id, discord_id, acquired_at)
    VALUES (?, ?, ?) ON CONFLICT(guild_id, discord_id) DO UPDATE SET acquired_at = excluded.acquired_at`);
const acquireCooldown = db.transaction((guildId, discordId, now) => {
    const previous = findCooldown.get(guildId, discordId);
    if (previous && previous.acquired_at + OFFER_COOLDOWN_MS > now) {
        return { allowed: false, retryAfterMs: previous.acquired_at + OFFER_COOLDOWN_MS - now };
    }
    saveCooldown.run(guildId, discordId, now);
    return { allowed: true, retryAfterMs: 0 };
});

function acquireOfferCooldown(guildId, discordId, { now = Date.now() } = {}) {
    return acquireCooldown.immediate(checkedIdentity(guildId, 'server ID'), checkedIdentity(discordId, 'buyer ID'), checkedNow(now));
}

const pendingToExpire = db.prepare(`SELECT id FROM escrow_transactions
    WHERE status = 'pending' AND julianday(created_at) <= julianday(?)
        AND (? IS NULL OR guild_id = ?)`);
const expireOne = db.prepare(`UPDATE escrow_transactions SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND status = 'pending' AND julianday(created_at) <= julianday(?)`);
const auditExpiry = db.prepare(`INSERT INTO escrow_events
    (escrow_id, event_type, from_status, to_status, actor_discord_id, reason, created_at)
    VALUES (?, 'offer_expired', 'pending', 'cancelled', NULL, ?, ?)`);
const expireOffers = db.transaction((guildId, now) => {
    const cutoff = new Date(now - PENDING_OFFER_TTL_MS).toISOString();
    const timestamp = new Date(now).toISOString().replace('T', ' ').replace(/Z$/, '');
    let expired = 0;
    for (const pending of pendingToExpire.all(cutoff, guildId, guildId)) {
        if (!expireOne.run(timestamp, pending.id, cutoff).changes) continue;
        auditExpiry.run(pending.id, EXPIRY_REASON, timestamp);
        expired += 1;
    }
    return expired;
});

/** Cancel only unaccepted offers; accepted, paid, disputed, and delivered deals never expire here. */
function expirePendingOffers({ guildId, now = Date.now() } = {}) {
    const scope = guildId == null ? null : checkedIdentity(guildId, 'server ID');
    return expireOffers.immediate(scope, checkedNow(now));
}

const activeCount = db.prepare(`SELECT COUNT(*) AS count FROM escrow_transactions
    WHERE guild_id = ? AND (buyer_id = ? OR seller_id = ?) AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`);

/** Call inside the same IMMEDIATE transaction that inserts the new deal. */
function assertActiveDealLimit(guildId, buyerId, { limit = MAX_ACTIVE_DEALS } = {}) {
    checkedIdentity(guildId, 'server ID');
    if (!Number.isSafeInteger(buyerId) || buyerId <= 0 || !Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error('A valid buyer profile and active-deal limit are required.');
    }
    const { count } = activeCount.get(guildId, buyerId, buyerId, ...ACTIVE_STATUSES);
    if (count >= limit) {
        const error = new Error(`You already have ${limit} active deals in this server. Complete or cancel an existing deal before opening another.`);
        error.code = 'ACTIVE_DEAL_LIMIT';
        throw error;
    }
    return count;
}

module.exports = {
    acquireOfferCooldown, expirePendingOffers, assertActiveDealLimit,
    OFFER_COOLDOWN_MS, PENDING_OFFER_TTL_MS, MAX_ACTIVE_DEALS, EXPIRY_REASON,
};
