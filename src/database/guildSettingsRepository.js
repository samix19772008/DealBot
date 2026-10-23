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

module.exports = { getGuildSettings, setModeratorRole, setRankRole, setHubChannel, setLanguage };
