const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setThreadCleanupMinutes } = require('../../database/guildSettingsRepository');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-thread-policy')
        .setDescription('Choose when finished deal conversations are archived after inactivity')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addIntegerOption(option => option.setName('archive-after')
            .setDescription('Archive finished conversations after this long without new messages')
            .setRequired(true)
            .addChoices(
                { name: 'Off — participant or staff closure only', value: 0 },
                { name: '15 minutes', value: 15 },
                { name: '30 minutes (default)', value: 30 },
                { name: '1 hour', value: 60 },
                { name: '24 hours', value: 1440 },
            )),
    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can change the finished-thread policy.', ephemeral: true, allowedMentions: { parse: [] } });
        }
        const minutes = interaction.options.getInteger('archive-after');
        try { setThreadCleanupMinutes(interaction.guildId, minutes); }
        catch (error) { return interaction.reply({ content: error.message, ephemeral: true, allowedMentions: { parse: [] } }); }
        return interaction.reply({
            content: minutes === 0
                ? 'Automatic finished-thread cleanup is disabled in this server. Participants and authorized staff can still close resolved conversations.'
                : `Finished deal conversations in this server will be archived after ${minutes} minutes without new messages. This also tidies existing finished conversations. Active and disputed deals are excluded. Records and saved transcripts are kept; no channels are deleted.`,
            ephemeral: true, allowedMentions: { parse: [] },
        });
    },
};
