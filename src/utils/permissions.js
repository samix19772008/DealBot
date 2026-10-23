const { PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../database/guildSettingsRepository');

function isModerator(member, guildId) {
    if (!member || !guildId || (member.guild && member.guild.id !== guildId)) return false;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    const settings = getGuildSettings(guildId);
    return Boolean(settings?.moderator_role_id && member.roles?.cache?.has(settings.moderator_role_id));
}

module.exports = { isModerator };
