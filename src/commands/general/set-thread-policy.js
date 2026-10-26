const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { db } = require('../../database/init');
const { setThreadCleanupMinutes, getThreadCleanupMinutes, THREAD_CLEANUP_MINUTES,
    setActiveThreadIdleMinutes, getActiveThreadIdleMinutes, ACTIVE_THREAD_IDLE_MINUTES } = require('../../database/guildSettingsRepository');

module.exports = {
    registered: false,
    data: new SlashCommandBuilder()
        .setName('set-thread-policy')
        .setDescription('Choose how quiet active and finished deal conversations are organized')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addIntegerOption(option => option.setName('archive-after')
            .setDescription('Archive finished conversations after this long without new messages')
            .addChoices(
                { name: 'Off — participant or staff closure only', value: 0 },
                { name: '15 minutes', value: 15 },
                { name: '30 minutes (default)', value: 30 },
                { name: '1 hour', value: 60 },
                { name: '24 hours', value: 1440 },
            ))
        .addIntegerOption(option => option.setName('idle-after')
            .setDescription('Tuck away quiet active conversations without ending their deals')
            .addChoices(
                { name: 'Off — keep active conversations open', value: 0 },
                { name: '5 minutes', value: 5 },
                { name: '15 minutes (default)', value: 15 },
                { name: '30 minutes', value: 30 },
                { name: '1 hour', value: 60 },
            )),
    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can change conversation organization.', ephemeral: true, allowedMentions: { parse: [] } });
        }
        const finished = interaction.options.getInteger('archive-after');
        const active = interaction.options.getInteger('idle-after');
        try {
            if (finished != null && !THREAD_CLEANUP_MINUTES.includes(finished)) {
                throw new Error('Choose a finished-chat archive delay of 0, 15, 30, 60, or 1440 minutes.');
            }
            if (active != null && !ACTIVE_THREAD_IDLE_MINUTES.includes(active)) {
                throw new Error('Choose an active-chat idle delay of 0, 5, 15, 30, or 60 minutes.');
            }
            // Both choices are validated first and committed together. Changing
            // one setting cannot leave a partial policy if the other fails.
            db.transaction(() => {
                if (finished != null) setThreadCleanupMinutes(interaction.guildId, finished);
                if (active != null) setActiveThreadIdleMinutes(interaction.guildId, active);
            }).immediate();
        } catch (error) {
            return interaction.reply({ content: error.message, ephemeral: true, allowedMentions: { parse: [] } });
        }
        const finishedMinutes = getThreadCleanupMinutes(interaction.guildId);
        const activeMinutes = getActiveThreadIdleMinutes(interaction.guildId);
        return interaction.reply({
            content: `**Conversation organization${finished == null && active == null ? ' · current settings' : ' · saved'}**\n` +
                `Finished conversations: ${finishedMinutes ? `archive after ${finishedMinutes} minutes without messages` : 'automatic cleanup disabled'}.\n` +
                `Quiet active conversations: ${activeMinutes ? `tuck away after ${activeMinutes} minutes without messages; open again from My Deals` : 'automatic hiding disabled'}.\n` +
                'Disputed deals are excluded. Tucking away a conversation does not complete or cancel its deal. Records and saved transcripts are kept; no channels are deleted.',
            ephemeral: true, allowedMentions: { parse: [] },
        });
    },
};
