const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getGuildSettings, getThreadCleanupMinutes, getActiveThreadIdleMinutes } = require('../../database/guildSettingsRepository');
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

const SETUP_ACTIONS = Object.freeze({
    hub: require('./set-hub-channel'),
    staff: require('./set-mod-role'),
    threads: require('./set-thread-policy'),
    'rank-role': require('./set-rank-role'),
    rank: require('./set-rank'),
    'review-flag': require('./review-flag'),
    stats: require('./stats'),
});
const OPTION_METHODS = Object.freeze({ 3: 'addStringOption', 4: 'addIntegerOption',
    6: 'addUserOption', 7: 'addChannelOption', 8: 'addRoleOption' });

function setupDefinition() {
    const definition = new SlashCommandBuilder().setName('setup')
        .setDescription('Set up this server or check its configuration')
        .setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand => subcommand.setName('check')
            .setDescription('Privately check this server configuration and required permissions'));
    for (const [name, command] of Object.entries(SETUP_ACTIONS)) {
        definition.addSubcommand(subcommand => {
            subcommand.setName(name).setDescription(command.data.description);
            for (const option of command.data.options) {
                const method = OPTION_METHODS[option.type];
                if (!method) throw new Error('Unsupported setup option type.');
                subcommand[method](option);
            }
            return subcommand;
        });
    }
    return definition;
}

module.exports = {
    data: setupDefinition(),
    async execute(interaction) {
        if (!interaction.guildId || !interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can configure or check this server.', ephemeral: true, allowedMentions: { parse: [] } });
        }
        // The fallback keeps already-issued /setup health checks usable while
        // Discord refreshes its definitions. New clients select /setup check.
        const selected = interaction.options?.getSubcommand?.(false) || 'check';
        if (selected === 'check') return runSetupCheck(interaction);
        const command = Object.hasOwn(SETUP_ACTIONS, selected) ? SETUP_ACTIONS[selected] : null;
        if (!command) return interaction.reply({ content: 'Choose an available /setup subcommand.', ephemeral: true, allowedMentions: { parse: [] } });
        return command.execute(interaction);
    },
};

async function runSetupCheck(interaction) {
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
            ? `${rankChecks.join('\n')}\nUse /setup rank-role to update a mapping. The bot needs Manage Roles; trust roles must be cosmetic.`
            : 'Not configured. Deals work without rank roles. Optionally use /setup rank-role to map cosmetic roles below the bot.';
        const embed = new EmbedBuilder()
            .setColor(ready ? 0x23A55A : 0xFEE75C)
            .setTitle('DealBot Setup Check')
            .setDescription(ready
                ? '✅ Required setup checks passed for this server. This check does not change channels, roles, or settings.'
                : 'Some required setup checks need attention. Follow the commands below, then run /setup check again. This check does not change channels, roles, or settings.')
            .addFields(
                { name: 'Required · Escrow Hub', value: validHub
                    ? `✅ <#${hub.id}> is a regular text channel in this server. Participants need View Channel, Read Message History, and Send Messages in Threads here.`
                    : '⚠️ A usable regular text channel is not configured. Run /setup hub channel:#your-escrow-hub.' },
                { name: 'Required · Bot Permissions', value: !bot
                    ? '⚠️ The bot member could not be fetched. Check that DealBot is installed in this server and try again.'
                    : !validHub ? '⚠️ Configure the hub first, then rerun /setup check to check effective channel permissions.'
                        : missingBot.length ? `⚠️ Grant these permissions to the bot in the hub: **${missingBot.join(', ')}**.`
                            : '✅ The bot has every required hub permission for private threads, deal messages, and attachments.' },
                { name: 'Required · Dispute Staff', value: !validStaffRole
                    ? '⚠️ Run /setup staff role:@EscrowStaff with a dedicated staff role that can view and manage private threads.'
                    : !validHub ? `⚠️ <@&${moderatorRole.id}> is configured. Configure the hub, then recheck its effective permissions.`
                        : missingStaff.length ? `⚠️ Grant <@&${moderatorRole.id}> these permissions in the hub: **${missingStaff.join(', ')}**. Then run /setup staff again.`
                            : `✅ <@&${moderatorRole.id}> can read and manage private deal threads and resolve disputes.` },
                { name: 'Optional · Trust Rank Roles', value: rankText },
                { name: 'Conversation Organization', value: getThreadCleanupMinutes(interaction.guildId)
                    ? `Finished conversations archive after ${getThreadCleanupMinutes(interaction.guildId)} minutes of inactivity. ${getActiveThreadIdleMinutes(interaction.guildId) ? `Quiet active conversations are tucked away after ${getActiveThreadIdleMinutes(interaction.guildId)} minutes and can be resumed from My Deals.` : 'Quiet active conversations are not tucked away automatically.'} Disputed deals are excluded. Use /setup threads to change these delays.`
                    : `Automatic finished-thread cleanup is disabled. ${getActiveThreadIdleMinutes(interaction.guildId) ? `Quiet active conversations are tucked away after ${getActiveThreadIdleMinutes(interaction.guildId)} minutes.` : 'Quiet active conversations are not tucked away automatically.'} Use /setup threads to change these settings; /deals opens My Deals.` },
                { name: 'Server Scope', value: 'Configuration, trust points, scam flags, manual rank overrides, and /setup stats are specific to this server. Use /help for the deal workflow and /setup stats for private activity totals.' },
            )
            .setFooter({ text: 'DealBot • Read-only health check • Optional rank roles do not block deals' })
            .setTimestamp();
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
