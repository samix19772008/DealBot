const { EmbedBuilder } = require('discord.js');
const { completeEscrow } = require('../../database/escrowRepository');
const { isModerator } = require('../../utils/permissions');
const { formatPayment } = require('../../utils/payments');
const { deny, getScopedDeal, sendCloseControls, syncDealRanks, completionRewardText } = require('../helpers');

module.exports = {
    id: 'resolve_complete_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isModerator(interaction.member, escrow.guild_id)) return deny(interaction, 'Only authorized moderators can resolve disputes.');
        if (escrow.status !== 'disputed') return deny(interaction, `This deal is ${escrow.status} and has no open dispute.`);
        await interaction.deferUpdate();
        if (!completeEscrow(escrow.id, escrow.buyer_id, escrow.seller_id, interaction.user.id, 'disputed')) {
            return deny(interaction, 'This dispute was already resolved. Trust points have not been awarded again.');
        }
        const embed = new EmbedBuilder().setColor(0x23A55A).setTitle('Dispute Resolved: Deal Completed')
            .setDescription(`Moderator <@${interaction.user.id}> completed deal \`${escrow.transaction_uuid}\`.`)
            .addFields(
                { name: 'Agreed Payment', value: formatPayment(escrow) },
                { name: 'Server Reputation', value: completionRewardText(escrow.id) },
            ).setTimestamp();
        await interaction.editReply({ content: null, embeds: [embed], components: [] });
        await sendCloseControls(interaction, escrow);
        await syncDealRanks(interaction, escrow);
    },
};
