const { db } = require('./init');
const RANK_KEYS = new Set(['bronze', 'silver', 'gold', 'platinum', 'diamond']);
const getSettingsStmt = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');

function getGuildSettings(guildId) {
    return guildId ? getSettingsStmt.get(guildId) : undefined;
}

function setSetting(guildId, column, value) {
    if (!guildId) throw new Error('Server settings cannot be changed outside a server.');
    db.prepare(`INSERT INTO guild_settings (guild_id, ${column}) VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column},
        updated_at = CURRENT_TIMESTAMP`).run(guildId, value);
}

function setModeratorRole(guildId, roleId) { setSetting(guildId, 'moderator_role_id', roleId); }
function setHubChannel(guildId, channelId) { setSetting(guildId, 'hub_channel_id', channelId); }
function setRankRole(guildId, rankKey, roleId) {
    if (!RANK_KEYS.has(rankKey)) throw new Error('Unknown trust rank.');
    setSetting(guildId, `${rankKey}_role_id`, roleId);
}
function setLanguage(guildId, language) {
    if (language !== 'en') throw new Error('This bot uses English only.');
    setSetting(guildId, 'language', 'en');
}

const THREAD_CLEANUP_MINUTES = Object.freeze([0, 15, 30, 60, 1440]);

function getThreadCleanupMinutes(guildId) {
    const minutes = getGuildSettings(guildId)?.thread_cleanup_minutes;
    return THREAD_CLEANUP_MINUTES.includes(minutes) ? minutes : 30;
}

function setThreadCleanupMinutes(guildId, minutes) {
    if (!Number.isInteger(minutes) || !THREAD_CLEANUP_MINUTES.includes(minutes)) {
        throw new Error('Choose a finished-chat archive delay of 0, 15, 30, 60, or 1440 minutes.');
    }
    return db.transaction(() => {
        const now = Date.now();
        setSetting(guildId, 'thread_cleanup_minutes', minutes);
        // Invalidate an old policy's claims. The worker rechecks the current
        // policy and conversation activity before touching Discord again.
        db.prepare(`UPDATE deal_thread_cleanup SET due_at = ?, lease_token = NULL, lease_until = NULL,
            updated_at = ? WHERE status = 'pending' AND escrow_id IN (
                SELECT id FROM escrow_transactions WHERE guild_id = ?
            )`).run(now, now, guildId);
        return minutes;
    }).immediate();
}

module.exports = { getGuildSettings, setModeratorRole, setRankRole, setHubChannel, setLanguage,
    getThreadCleanupMinutes, setThreadCleanupMinutes, THREAD_CLEANUP_MINUTES };
