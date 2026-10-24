const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getGuildSettings } = require('../../database/guildSettingsRepository');
const { RANKS } = require('../../utils/ranks');
const { isSafeRankRole } = require('../../utils/roleSync');

const HUB_PERMISSIONS = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Send Messages', PermissionFlagsBits.SendMessages],
    ['Create Private Threads', PermissionFlagsBits.CreatePrivateThreads],
    ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads],
    ['Manage Threads', PermissionFlagsBits.ManageThreads],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
    ['Embed Links', PermissionFlagsBits.EmbedLinks],
    ['Attach Files', PermissionFlagsBits.AttachFiles],
];
const STAFF_PERMISSIONS = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
    ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads],
    ['Manage Threads', PermissionFlagsBits.ManageThreads],
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Check this server\'s escrow configuration and required permissions')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can check escrow setup.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const settings = getGuildSettings(interaction.guildId);
        const [bot, hub, moderatorRole] = await Promise.all([
            interaction.guild.members.fetchMe().catch(() => null),
            settings?.hub_channel_id ? interaction.guild.channels.fetch(settings.hub_channel_id).catch(() => null) : null,
            settings?.moderator_role_id ? interaction.guild.roles.fetch(settings.moderator_role_id).catch(() => null) : null,
        ]);
        const validHub = hub && hub.guildId === interaction.guildId && hub.type === ChannelType.GuildText;
        const missingBot = validHub && bot
            ? HUB_PERMISSIONS.filter(([, permission]) => !hub.permissionsFor(bot)?.has(permission)).map(([name]) => name)
            : HUB_PERMISSIONS.map(([name]) => name);
        const validStaffRole = moderatorRole && moderatorRole.id !== interaction.guildId && !moderatorRole.managed;
        const missingStaff = validHub && validStaffRole
            ? STAFF_PERMISSIONS.filter(([, permission]) => !hub.permissionsFor(moderatorRole)?.has(permission)).map(([name]) => name)
            : STAFF_PERMISSIONS.map(([name]) => name);
        const ready = Boolean(validHub && bot && !missingBot.length && validStaffRole && !missingStaff.length);

        const rankMappings = RANKS.filter(rank => settings?.[`${rank.key}_role_id`]);
        const rankChecks = await Promise.all(rankMappings.map(async rank => {
            const roleId = settings[`${rank.key}_role_id`];
            const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
            const duplicate = rankMappings.some(other => other.key !== rank.key && settings[`${other.key}_role_id`] === roleId);
            const safe = roleId !== settings?.moderator_role_id && !duplicate && isSafeRankRole(role, bot, interaction.guildId);
            return `${safe ? '✅' : '⚠️'} **${rank.label}**: ${safe ? `<@&${roleId}> is safe and below the bot` : 'check role existence, permissions, hierarchy, and unique mapping'}`;
        }));
        const rankText = rankChecks.length
            ? `${rankChecks.join('\n')}\nUse /set-rank-role to update a mapping. The bot needs Manage Roles; trust roles must be cosmetic.`
            : 'Not configured. Deals work without rank roles. Optionally use /set-rank-role to map cosmetic roles below the bot.';
        const embed = new EmbedBuilder()
            .setColor(ready ? 0x23A55A : 0xFEE75C)
            .setTitle('DealBot Setup Check')
            .setDescription(ready
                ? '✅ Required setup checks passed for this server. This check does not change channels, roles, or settings.'
                : 'Some required setup checks need attention. Follow the commands below, then run /setup again. This check does not change channels, roles, or settings.')
            .addFields(
                { name: 'Required · Escrow Hub', value: validHub
                    ? `✅ <#${hub.id}> is a regular text channel in this server. Participants need View Channel, Read Message History, and Send Messages in Threads here.`
                    : '⚠️ A usable regular text channel is not configured. Run /set-hub-channel channel:#your-escrow-hub.' },
                { name: 'Required · Bot Permissions', value: !bot
                    ? '⚠️ The bot member could not be fetched. Check that DealBot is installed in this server and try again.'
                    : !validHub ? '⚠️ Configure the hub first, then rerun /setup to check effective channel permissions.'
                        : missingBot.length ? `⚠️ Grant these permissions to the bot in the hub: **${missingBot.join(', ')}**.`
                            : '✅ The bot has every required hub permission for private threads, deal messages, and attachments.' },
                { name: 'Required · Dispute Staff', value: !validStaffRole
                    ? '⚠️ Run /set-mod-role role:@EscrowStaff with a dedicated staff role that can view and manage private threads.'
                    : !validHub ? `⚠️ <@&${moderatorRole.id}> is configured. Configure the hub, then recheck its effective permissions.`
                        : missingStaff.length ? `⚠️ Grant <@&${moderatorRole.id}> these permissions in the hub: **${missingStaff.join(', ')}**. Then run /set-mod-role again.`
                            : `✅ <@&${moderatorRole.id}> can read and manage private deal threads and resolve disputes.` },
                { name: 'Optional · Trust Rank Roles', value: rankText },
                { name: 'Server Scope', value: 'Configuration, trust points, scam flags, manual rank overrides, and /stats are specific to this server. Use /help for the deal workflow and /stats for private activity totals.' },
            )
            .setFooter({ text: 'DealBot • Read-only health check • Optional rank roles do not block deals' })
            .setTimestamp();
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    },
};
