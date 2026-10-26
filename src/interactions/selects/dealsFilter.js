const { buildDealDashboard, parseDashboardControl, DASHBOARD_FILTERS } = require('../../utils/dealDashboard');
const { deny } = require('../helpers');

module.exports = {
    id: 'deals_filter_',
    async execute(interaction) {
        try {
            const view = parseDashboardControl(interaction, this.id);
            if (interaction.values?.length !== 1 || !DASHBOARD_FILTERS.some(filter => filter.key === interaction.values[0])) {
                return deny(interaction, 'Choose one available deal view from this dashboard.');
            }
            return interaction.update(buildDealDashboard({ ...view, status: interaction.values[0], page: 1 }));
        } catch (error) {
            if (error.code !== 'DASHBOARD_INPUT_INVALID') throw error;
            return deny(interaction, error.message);
        }
    },
};
