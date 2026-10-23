const { cancelEscrow } = require('../../database/escrowRepository');
const { deny, getScopedDeal, isParticipant, confirmedEmbed } = require('../helpers');

module.exports = {
    id: 'cancel_reason_modal_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length), { allowDm: true });
        if (!escrow) return;
        if (!isParticipant(interaction, escrow)) {
            return deny(interaction, 'Only the buyer or seller can cancel this deal.');
        }
        if (escrow.status !== 'pending') {
            return deny(interaction, `This deal is already ${escrow.status} and can no longer be cancelled from this request.`);
        }
        const reason = interaction.fields.getTextInputValue('reason')?.trim() || 'No reason given';
        if (reason.length > 300) return deny(interaction, 'The cancellation reason must be 300 characters or fewer.');
        await interaction.deferUpdate();
        if (!cancelEscrow(escrow.id, { actorId: interaction.user.id, reason })) {
            return deny(interaction, 'This deal changed while you were responding. Refresh its status and try again.');
        }
        await interaction.editReply({
            embeds: [confirmedEmbed(interaction, `Cancelled by ${interaction.user.tag} • ${reason}`, 0xED4245)],
            components: [],
        });
        const otherPartyId = interaction.user.id === escrow.buyer_discord_id
            ? escrow.seller_discord_id : escrow.buyer_discord_id;
        try {
            const otherUser = await interaction.client.users.fetch(otherPartyId);
            await otherUser.send({
                content: `❌ Deal \`${escrow.transaction_uuid}\` was cancelled by <@${interaction.user.id}>.\n**Reason:** ${reason}`,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.warn('[DEAL] Could not send cancellation notification:', error.message);
        }
    },
};
