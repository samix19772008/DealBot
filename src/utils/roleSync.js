const { PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../database/guildSettingsRepository');
const { getRankForScore, RANKS } = require('./ranks');

// Trust ranks are cosmetic. Never grant moderation or server-management powers.
const DANGEROUS_RANK_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.ManageGuildExpressions,
    PermissionFlagsBits.ManageEvents,
    PermissionFlagsBits.ManageNicknames,
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.DeafenMembers,
    PermissionFlagsBits.MoveMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.MentionEveryone,
];

function isSafeRankRole(role, botMember, guildId) {
    if (!role || !botMember || !role.permissions?.has) return false;
    if (role.id === guildId || role.managed || role.editable === false) return false;
    if (DANGEROUS_RANK_PERMISSIONS.some(permission => role.permissions.has(permission))) return false;
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) return false;
    const botHighest = botMember.roles?.highest;
    if (!botHighest || !Number.isFinite(role.position) || !Number.isFinite(botHighest.position)) return false;
    return role.position < botHighest.position;
}

/** Sync cosmetic rank roles only when both permissions and hierarchy allow it. */
async function syncMemberRankRole(member, trustScore) {
    if (!member?.guild) return false;
    const settings = getGuildSettings(member.guild.id);
    if (!settings) return true;

    const configuredIds = [...new Set(RANKS.map(rank => settings[`${rank.key}_role_id`]).filter(Boolean))];
    if (!configuredIds.length) return true;

    try {
        const botMember = member.guild.members.me ?? await member.guild.members.fetchMe();
        if (member.manageable === false) {
            console.warn('[ROLE SYNC] Member is above the bot in the role hierarchy.');
            return false;
        }
        const currentRank = getRankForScore(trustScore);
        const targetRoleId = settings[`${currentRank.key}_role_id`];
        const targetRole = targetRoleId ? member.guild.roles.cache.get(targetRoleId) : null;
        if (targetRoleId && !isSafeRankRole(targetRole, botMember, member.guild.id)) {
            console.warn('[ROLE SYNC] Skipped an unsafe or unmanageable target rank role.');
            return false;
        }

        let success = true;
        for (const roleId of configuredIds) {
            if (roleId === targetRoleId || !member.roles.cache.has(roleId)) continue;
            const role = member.guild.roles.cache.get(roleId);
            if (!isSafeRankRole(role, botMember, member.guild.id)) {
                console.warn('[ROLE SYNC] Skipped an unsafe or unmanageable old rank role.');
                success = false;
                continue;
            }
            await member.roles.remove(roleId, 'Trust rank updated');
        }

        if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
            await member.roles.add(targetRoleId, 'Trust rank updated');
        }
        return success;
    } catch (error) {
        console.warn('[ROLE SYNC] Could not update cosmetic rank roles:', error.message);
        return false;
    }
}

module.exports = { syncMemberRankRole, isSafeRankRole, DANGEROUS_RANK_PERMISSIONS };
