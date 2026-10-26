const { getEscrowById } = require('../../database/escrowRepository');
const { parseDashboardControl } = require('../../utils/dealDashboard');
const { showDealStatus } = require('../../commands/escrow/deal-status');
const { deny } = require('../helpers');

module.exports = {
    id: 'deals_pick_',
    async execute(interaction) {
        try { parseDashboardControl(interaction, this.id); }
        catch (error) {
            if (error.code !== 'DASHBOARD_INPUT_INVALID') throw error;
            return deny(interaction, error.message);
        }
        const id = interaction.values?.length === 1 && /^\d+$/.test(interaction.values[0]) ? interaction.values[0] : null;
        const deal = id && getEscrowById(id);
        if (!deal || deal.guild_id !== interaction.guildId ||
            ![deal.buyer_discord_id, deal.seller_discord_id].includes(interaction.user.id)) {
            return deny(interaction, 'This deal is not in your private dashboard. Refresh /deals and choose one of your deals.');
        }
        return showDealStatus(interaction, String(deal.id), { allowResume: true });
    },
};
