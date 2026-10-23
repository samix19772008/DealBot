const { db } = require('./init');
const findByDiscordId = db.prepare('SELECT * FROM users WHERE discord_id = ?');
const saveUser = db.prepare(`INSERT INTO users (discord_id, username, account_created_at)
    VALUES (@discord_id, @username, @account_created_at)
    ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username,
        updated_at = CASE WHEN users.username != excluded.username THEN CURRENT_TIMESTAMP ELSE users.updated_at END`);

function getOrCreateUser(discordUser) {
    saveUser.run({
        discord_id: discordUser.id,
        username: discordUser.tag || discordUser.username,
        account_created_at: discordUser.createdAt.toISOString(),
    });
    return findByDiscordId.get(discordUser.id);
}

/** Prefer flagScammerAndCancel for dispute decisions so flagging and closure are atomic. */
function flagAsScammer(userId) {
    return db.prepare(`UPDATE users SET is_scammer = 1, scam_flag_count = scam_flag_count + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(userId).changes > 0;
}

function setTrustScore(userId, score) {
    if (!Number.isSafeInteger(score) || score < 0) throw new Error('Trust points must be a non-negative integer.');
    return db.prepare('UPDATE users SET trust_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(score, userId).changes > 0;
}

module.exports = { getOrCreateUser, flagAsScammer, setTrustScore };
