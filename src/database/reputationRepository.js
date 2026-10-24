// Database access is intentionally lazy: init.js reuses the pure backfill helpers
// after creating tables, before repositories can prepare statements.
const database = () => require('./init').db;
const REWARD_POINTS = 5;
const REWARD_WINDOW_HOURS = 24;

function checkedGuild(guildId) {
    if (typeof guildId !== 'string' || !guildId.trim() || guildId.length > 128) throw new Error('A server ID is required for reputation.');
    return guildId.trim();
}
function checkedUser(db, userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0 || !db.prepare('SELECT id FROM users WHERE id = ?').get(id)) {
        throw new Error('A stored user identity is required for reputation.');
    }
    return id;
}
function checkedActor(actorId) {
    if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > 128) throw new Error('The staff member making this decision must be recorded.');
    return actorId.trim();
}
function ensureProfile(db, guildId, userId) {
    db.prepare('INSERT INTO guild_user_profiles (guild_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(guildId, userId);
}
function getGuildReputation(guildId, userId) {
    const db = database();
    const guild = checkedGuild(guildId);
    const id = checkedUser(db, userId);
    ensureProfile(db, guild, id);
    const result = db.prepare('SELECT *, COALESCE(rank_override_points, earned_points) AS trust_score FROM guild_user_profiles WHERE guild_id = ? AND user_id = ?').get(guild, id);
    result.unique_partners = db.prepare(`SELECT COUNT(DISTINCT CASE WHEN buyer_id = ? THEN seller_id ELSE buyer_id END) AS count
        FROM escrow_reward_ledger WHERE guild_id = ? AND (buyer_id = ? OR seller_id = ?) AND buyer_id != seller_id`).get(id, guild, id, id).count;
    return result;
}

function changeOverride(guildId, userId, score, actorDiscordId) {
    const db = database();
    const guild = checkedGuild(guildId);
    const id = checkedUser(db, userId);
    const actor = checkedActor(actorDiscordId);
    if (score !== null && (!Number.isSafeInteger(score) || score < 0)) throw new Error('A manual rank override must be a non-negative integer.');
    return db.transaction(() => {
        ensureProfile(db, guild, id);
        const current = db.prepare('SELECT rank_override_points FROM guild_user_profiles WHERE guild_id = ? AND user_id = ?').get(guild, id).rank_override_points;
        if (current === score) return false;
        db.prepare('UPDATE guild_user_profiles SET rank_override_points = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ?').run(score, guild, id);
        db.prepare(`INSERT INTO guild_rank_override_audit
            (guild_id, user_id, actor_discord_id, old_override_points, new_override_points) VALUES (?, ?, ?, ?, ?)`)
            .run(guild, id, actor, current, score);
        return true;
    }).immediate();
}
function setGuildRankOverride(guildId, userId, score, actorDiscordId) { return changeOverride(guildId, userId, score, actorDiscordId); }
function clearGuildRankOverride(guildId, userId, actorDiscordId) { return changeOverride(guildId, userId, null, actorDiscordId); }

function clearGuildScamFlag(guildId, userId, actorDiscordId, reason) {
    const db = database();
    const guild = checkedGuild(guildId);
    const id = checkedUser(db, userId);
    const actor = checkedActor(actorDiscordId);
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 1000) {
        throw new Error('Explain the flag review in 10 to 1,000 characters.');
    }
    return db.transaction(() => {
        ensureProfile(db, guild, id);
        if (!db.prepare('UPDATE guild_user_profiles SET is_scammer = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ? AND is_scammer = 1').run(guild, id).changes) return false;
        db.prepare(`INSERT INTO guild_flag_review_audit
            (guild_id, user_id, actor_discord_id, reason, old_is_scammer, new_is_scammer) VALUES (?, ?, ?, ?, 1, 0)`)
            .run(guild, id, actor, reason.trim());
        return true;
    }).immediate();
}

function normalizedCompletionTime(db, escrow) {
    // A completed row is evidence of a deal; a missing/unparseable time is not
    // evidence that it qualifies for a new time-limited points award.
    const candidate = escrow.completed_at || escrow.updated_at || escrow.created_at;
    return db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', ?) AS time").get(candidate).time;
}
function applyCompletion(db, escrow, source) {
    if (db.prepare('SELECT escrow_id FROM escrow_reward_ledger WHERE escrow_id = ?').get(escrow.id)) return false;
    const time = normalizedCompletionTime(db, escrow);
    const low = Math.min(escrow.buyer_id, escrow.seller_id);
    const high = Math.max(escrow.buyer_id, escrow.seller_id);
    const alreadyRewarded = time && db.prepare(`SELECT escrow_id FROM escrow_reward_ledger
        WHERE guild_id = ? AND pair_low_user_id = ? AND pair_high_user_id = ? AND awarded_points > 0
            AND julianday(completed_at) > julianday(?, '-24 hours') AND julianday(completed_at) <= julianday(?) LIMIT 1`)
        .get(escrow.guild_id, low, high, time, time);
    const points = time && low !== high && !alreadyRewarded ? REWARD_POINTS : 0;
    db.prepare(`INSERT INTO escrow_reward_ledger
        (escrow_id, guild_id, buyer_id, seller_id, pair_low_user_id, pair_high_user_id, awarded_points, completed_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(escrow.id, escrow.guild_id, escrow.buyer_id, escrow.seller_id, low, high, points, time, source);
    for (const userId of new Set([escrow.buyer_id, escrow.seller_id])) {
        ensureProfile(db, escrow.guild_id, userId);
        db.prepare(`UPDATE guild_user_profiles SET successful_deals = successful_deals + 1,
            earned_points = earned_points + ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ?`)
            .run(points, escrow.guild_id, userId);
    }
    return true;
}
function recordCompletedEscrow(escrowId) {
    const db = database();
    return db.transaction(() => {
        const escrow = db.prepare("SELECT * FROM escrow_transactions WHERE id = ? AND status = 'completed'").get(escrowId);
        return escrow ? applyCompletion(db, escrow, 'completion') : false;
    }).immediate();
}
function getEscrowReward(escrowId) {
    return database().prepare('SELECT * FROM escrow_reward_ledger WHERE escrow_id = ?').get(escrowId);
}

function applyScamFlag(db, escrow, userId, event) {
    if (![escrow.buyer_id, escrow.seller_id].includes(userId)) throw new Error('A scam flag must refer to a participant in this deal.');
    const result = db.prepare(`INSERT INTO guild_scam_flag_ledger (event_id, guild_id, user_id, escrow_id, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`).run(event.id, escrow.guild_id, userId, escrow.id, event.created_at);
    if (!result.changes) return false;
    ensureProfile(db, escrow.guild_id, userId);
    db.prepare(`UPDATE guild_user_profiles SET is_scammer = 1, scam_flag_count = scam_flag_count + 1,
        failed_deals = failed_deals + 1, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND user_id = ?`).run(escrow.guild_id, userId);
    return true;
}
function recordScamFlag(escrowId, userId, eventId) {
    const db = database();
    return db.transaction(() => {
        const escrow = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
        const event = db.prepare("SELECT * FROM escrow_events WHERE id = ? AND escrow_id = ? AND event_type = 'scammer_flagged'").get(eventId, escrowId);
        const user = db.prepare('SELECT discord_id FROM users WHERE id = ?').get(userId);
        if (!escrow || !event || !user || event.reason !== `Flagged participant: ${user.discord_id}`) throw new Error('A recorded moderator decision is required for this scam flag.');
        return applyScamFlag(db, escrow, userId, event);
    }).immediate();
}

/** Import only source records whose server and participants are actually known. */
function backfillGuildReputation(db) {
    const completed = db.prepare(`SELECT e.* FROM escrow_transactions e
        LEFT JOIN escrow_reward_ledger r ON r.escrow_id = e.id
        WHERE e.status = 'completed' AND r.escrow_id IS NULL
        ORDER BY julianday(COALESCE(e.completed_at, e.updated_at, e.created_at)), e.id`).all();
    for (const escrow of completed) applyCompletion(db, escrow, 'backfill');
    const events = db.prepare(`SELECT ev.* FROM escrow_events ev
        LEFT JOIN guild_scam_flag_ledger f ON f.event_id = ev.id
        WHERE ev.event_type = 'scammer_flagged' AND f.event_id IS NULL ORDER BY ev.id`).all();
    for (const event of events) {
        const escrow = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(event.escrow_id);
        if (!escrow) continue;
        for (const userId of new Set([escrow.buyer_id, escrow.seller_id])) {
            const user = db.prepare('SELECT discord_id FROM users WHERE id = ?').get(userId);
            if (event.reason === `Flagged participant: ${user.discord_id}`) applyScamFlag(db, escrow, userId, event);
        }
    }
}

function getGuildStats(guildId, { days = 30 } = {}) {
    const db = database();
    const guild = checkedGuild(guildId);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('Choose a reporting window between 1 and 365 days.');
    const modifier = `-${days} days`;
    const cohort = db.prepare(`SELECT COUNT(*) AS created,
        COALESCE(SUM(status = 'completed'), 0) AS completed, COALESCE(SUM(status = 'disputed'), 0) AS disputed,
        COALESCE(SUM(status = 'cancelled'), 0) AS cancelled, COALESCE(SUM(status = 'refunded'), 0) AS refunded
        FROM escrow_transactions WHERE guild_id = ? AND julianday(created_at) >= julianday('now', ?)`)
        .get(guild, modifier);
    const activeCount = db.prepare(`SELECT COUNT(*) AS count FROM escrow_transactions WHERE guild_id = ?
        AND status IN ('pending', 'awaiting_payment', 'funded', 'delivered', 'disputed')`).get(guild).count;
    const uniqueTraders = db.prepare(`SELECT COUNT(*) AS count FROM (
        SELECT buyer_id AS user_id FROM escrow_transactions WHERE guild_id = ? AND julianday(created_at) >= julianday('now', ?)
        UNION SELECT seller_id FROM escrow_transactions WHERE guild_id = ? AND julianday(created_at) >= julianday('now', ?))`)
        .get(guild, modifier, guild, modifier).count;
    return { days, ...cohort, activeCount, uniqueTraders, completionNumerator: cohort.completed,
        completionDenominator: cohort.created, completionRate: cohort.created ? cohort.completed / cohort.created : null };
}

module.exports = { getGuildReputation, setGuildRankOverride, clearGuildRankOverride, clearGuildScamFlag,
    getEscrowReward, getGuildStats, recordCompletedEscrow, recordScamFlag, backfillGuildReputation,
    REWARD_POINTS, REWARD_WINDOW_HOURS };
