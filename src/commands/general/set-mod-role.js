const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, setModeratorRole } = require('../../database/guildSettingsRepository');
const { RANKS } = require('../../utils/ranks');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-mod-role')
        .setDescription('Set the staff role authorized to resolve escrow disputes')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addRoleOption(option => option
            .setName('role').setDescription('A staff role with permission to manage private threads').setRequired(true)),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can set the moderator role.', ephemeral: true });
        }
        const role = interaction.options.getRole('role');
        if (!role || role.id === interaction.guildId || role.managed) {
            return interaction.reply({ content: 'Choose a dedicated staff role, not @everyone or an integration role.', ephemeral: true });
        }
        const settings = getGuildSettings(interaction.guildId);
        if (RANKS.some(rank => settings?.[`${rank.key}_role_id`] === role.id)) {
            return interaction.reply({ content: 'This role is assigned automatically as a trust rank. Choose a separate staff role.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const hub = settings?.hub_channel_id
            ? await interaction.guild.channels.fetch(settings.hub_channel_id).catch(() => null)
            : null;
        const permissions = hub?.permissionsFor(role) ?? role.permissions;
        const required = hub
            ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads]
            : [PermissionFlagsBits.ManageThreads];
        if (!permissions || !required.every(flag => permissions.has(flag))) {
            return interaction.editReply('This staff role needs View Channel, Read Message History, Send Messages in Threads, and Manage Threads in the escrow hub to review private disputes.');
        }
        setModeratorRole(interaction.guildId, role.id);
        return interaction.editReply({
            content: `✅ <@&${role.id}> can now resolve escrow disputes. Staff must retain access to private threads in the escrow hub.`,
            allowedMentions: { parse: [] },
        });
    },
};
