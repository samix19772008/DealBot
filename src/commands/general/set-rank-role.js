const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, setRankRole } = require('../../database/guildSettingsRepository');
const { RANKS, getRankByKey } = require('../../utils/ranks');
const { isSafeRankRole } = require('../../utils/roleSync');

module.exports = {
    registered: false,
    data: new SlashCommandBuilder()
        .setName('set-rank-role')
        .setDescription('Link a trust rank to a safe, automatically assigned Discord role')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => option
            .setName('rank').setDescription('The trust rank to link').setRequired(true)
            .addChoices(...RANKS.map(rank => ({ name: `${rank.emoji} ${rank.label}`, value: rank.key }))))
        .addRoleOption(option => option
            .setName('role').setDescription('A cosmetic role below the bot, without staff permissions').setRequired(true)),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can configure rank roles.', ephemeral: true });
        }
        const rankKey = interaction.options.getString('rank');
        const role = interaction.options.getRole('role');
        if (!getRankByKey(rankKey)) {
            return interaction.reply({ content: 'Choose one of the available trust ranks.', ephemeral: true });
        }
        const settings = getGuildSettings(interaction.guildId);
        if (settings?.moderator_role_id === role?.id || RANKS.some(rank => rank.key !== rankKey && settings?.[`${rank.key}_role_id`] === role?.id)) {
            return interaction.reply({ content: 'This role is already used by staff or another trust rank. Choose a separate role for each rank.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || !isSafeRankRole(role, me, interaction.guildId)) {
            return interaction.editReply('Choose a cosmetic role below my highest role, without administrator or staff permissions. Integration roles and @everyone cannot be used. I also need Manage Roles.');
        }
        setRankRole(interaction.guildId, rankKey, role.id);
        return interaction.editReply({ content: `✅ **${getRankByKey(rankKey).label}** is linked to <@&${role.id}>.`, allowedMentions: { parse: [] } });
    },
};
