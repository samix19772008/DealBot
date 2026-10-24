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

/** @deprecated Global reputation changes are disabled. Resolve a server-scoped dispute instead. */
function flagAsScammer() {
    throw new Error('Global scam flags are disabled. Use server-scoped flagScammerAndCancel.');
}

/** @deprecated Use setGuildRankOverride with an explicit server and staff identity. */
function setTrustScore() {
    throw new Error('Global trust overrides are disabled. Use setGuildRankOverride with a server ID.');
}

module.exports = { getOrCreateUser, flagAsScammer, setTrustScore };
