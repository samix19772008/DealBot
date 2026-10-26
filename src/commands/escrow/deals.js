const { SlashCommandBuilder } = require('discord.js');
const { buildDealDashboard, DASHBOARD_FILTERS, MAX_DASHBOARD_PAGE } = require('../../utils/dealDashboard');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deals')
        .setDescription('Open your private deal dashboard in this server')
        .setDMPermission(false)
        .addStringOption(option => option
            .setName('status').setDescription('Filter active deals, your next actions, completed deals, or all history')
            .addChoices(...DASHBOARD_FILTERS.map(filter => ({ name: filter.label, value: filter.key }))))
        .addIntegerOption(option => option
            .setName('page').setDescription('Page number').setMinValue(1).setMaxValue(MAX_DASHBOARD_PAGE)),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Use this command inside your escrow server.', ephemeral: true });
        }
        try {
            const payload = buildDealDashboard({ guildId: interaction.guildId, userId: interaction.user.id,
                status: interaction.options.getString('status') ?? 'active',
                page: interaction.options.getInteger('page') ?? 1 });
            return interaction.reply({ ...payload, ephemeral: true });
        } catch (error) {
            if (error.code !== 'DASHBOARD_INPUT_INVALID') throw error;
            return interaction.reply({ content: error.message, ephemeral: true, allowedMentions: { parse: [] } });
        }
    },
};
