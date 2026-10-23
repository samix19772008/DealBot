const { completeEscrow } = require('../../database/escrowRepository');
const { buildDealEmbed } = require('../../utils/embedTemplate');
const { deny, getScopedDeal, confirmedEmbed, sendCloseControls, syncDealRanks } = require('../helpers');

module.exports = {
    id: 'confirm_receipt_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (interaction.user.id !== escrow.buyer_discord_id) return deny(interaction, 'Only the buyer can confirm receipt on this deal.');
        if (escrow.status !== 'delivered') return deny(interaction, `This deal is ${escrow.status}; receipt cannot be confirmed now.`);
        await interaction.deferUpdate();
        if (!completeEscrow(escrow.id, escrow.buyer_id, escrow.seller_id, interaction.user.id)) {
            return deny(interaction, 'This deal changed or was already completed. Trust points have not been awarded again.');
        }
        await interaction.editReply({ embeds: [confirmedEmbed(interaction, `Receipt confirmed by ${interaction.user.tag}`)], components: [] });
        const embed = buildDealEmbed({
            title: 'Deal Completed Successfully', referenceId: escrow.transaction_uuid, status: 'success',
            rows: [
                { label: 'Buyer', value: `<@${escrow.buyer_discord_id}>` },
                { label: 'Seller', value: `<@${escrow.seller_discord_id}>` },
                { label: 'Amount', value: `${escrow.amount.toLocaleString('en-US')} ${escrow.currency}` },
                { label: 'Trust Reward', value: 'Both participants earned 5 trust points and one successful deal.' },
            ],
        });
        await interaction.channel.send({ embeds: [embed] });
        await sendCloseControls(interaction, escrow);
        await syncDealRanks(interaction, escrow);
    },
};
