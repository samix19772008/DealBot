const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getOrCreateUser } = require('../../database/userRepository');
const { getGuildReputation, clearGuildScamFlag } = require('../../database/reputationRepository');
const { syncMemberRankRole } = require('../../utils/roleSync');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('review-flag')
        .setDescription('Review and clear an active scam flag in this server, preserving its history')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option => option
            .setName('user').setDescription('The user whose local scam flag was reviewed').setRequired(true))
        .addStringOption(option => option
            .setName('reason').setDescription('Why the active flag should be cleared (10–1,000 characters)')
            .setMinLength(10).setMaxLength(1000).setRequired(true)),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can review scam flags.', ephemeral: true });
        }
        const target = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason')?.trim();
        if (!target || target.bot || !reason || reason.length < 10 || reason.length > 1000) {
            return interaction.reply({ content: 'Choose a valid user and give a review reason of 10 to 1,000 characters.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const identity = getOrCreateUser(target);
        const reputation = getGuildReputation(interaction.guildId, identity.id);
        if (!reputation.is_scammer || !clearGuildScamFlag(interaction.guildId, identity.id, interaction.user.id, reason)) {
            return interaction.editReply({ content: 'This user has no active scam flag in this server. No flag review change was saved.' });
        }
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        const synced = member?.guild?.id === interaction.guildId ? await syncMemberRankRole(member) : null;
        const roleNote = synced === null
            ? ' The user is not currently in this server, so no Discord roles were changed.'
            : synced ? ' Cosmetic trust roles were synchronized.' : ' The flag was cleared, but cosmetic trust roles could not be fully synchronized; check bot permissions and role configuration.';
        return interaction.editReply({
            content: `✅ The active scam flag for <@${target.id}> was cleared **in this server only**. Historical flag decisions and review records are preserved.\n**Review reason:** ${reason}${roleNote}`,
            allowedMentions: { parse: [] },
        });
    },
};
