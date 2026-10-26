const { buildDealDashboard, parseDashboardControl, MAX_DASHBOARD_PAGE } = require('../../utils/dealDashboard');
const { deny } = require('../helpers');

module.exports = {
    id: 'deals_page_',
    async execute(interaction) {
        let view;
        try {
            view = parseDashboardControl(interaction, this.id, { action: true });
            if (view.operation === 'prev') view.page = Math.max(1, view.page - 1);
            if (view.operation === 'next') view.page = Math.min(MAX_DASHBOARD_PAGE, view.page + 1);
            return interaction.update(buildDealDashboard(view));
        } catch (error) {
            if (error.code !== 'DASHBOARD_INPUT_INVALID') throw error;
            return deny(interaction, error.message);
        }
    },
};
