const { EmbedBuilder } = require('discord.js');
const { getEscrowById, approveBuyerClose, approveSellerClose } = require('../../database/escrowRepository');
const { closeDealThread } = require('../../utils/threadClosure');
const { deny, getScopedDeal, isParticipant, closeButtons } = require('../helpers');

async function reportMetadataDelay(interaction, result) {
    if (!result.metadataPending) return;
    console.warn('[CLOSE] Conversation archived; closure metadata is pending:', result.metadataError?.message || 'No archive record returned');
    await deny(interaction, 'The conversation was archived successfully. Its closure details are still being finalized.').catch(() => {});
}

module.exports = {
    id: 'approve_close_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isParticipant(interaction, escrow)) return deny(interaction, 'Only the buyer or seller can approve closing this conversation.');
        if (!['completed', 'cancelled', 'refunded'].includes(escrow.status)) {
            return deny(interaction, 'This deal is still active. Complete it or have a moderator resolve its dispute before closing.');
        }
        if (!interaction.channel?.isThread?.()) return deny(interaction, 'This action requires the private deal thread.');
        await interaction.deferUpdate();
        const approve = interaction.user.id === escrow.buyer_discord_id ? approveBuyerClose : approveSellerClose;
        const changed = approve(escrow.id, interaction.user.id);
        const updated = getEscrowById(escrow.id);
        const approvalColumn = interaction.user.id === escrow.buyer_discord_id ? 'buyer_close_approved' : 'seller_close_approved';
        if (!changed && !updated?.[approvalColumn]) return deny(interaction, 'This deal changed. Check its status before closing.');
        const bothApproved = Boolean(updated.buyer_close_approved && updated.seller_close_approved);
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Close Conversation')
            .setDescription(`Deal \`${escrow.transaction_uuid}\``)
            .addFields(
                { name: 'Buyer Approval', value: updated.buyer_close_approved ? '✅ Approved' : '⬜ Pending', inline: true },
                { name: 'Seller Approval', value: updated.seller_close_approved ? '✅ Approved' : '⬜ Pending', inline: true },
            );
        if (!bothApproved) {
            if (!changed) return deny(interaction, 'You have already approved closing. Waiting for the other participant.');
            return interaction.editReply({ embeds: [embed] });
        }
        const options = {
            channel: interaction.channel, escrowId: escrow.id, actor: interaction.user,
            kind: 'participant', reason: 'Both deal participants approved closing',
        };
        try {
            if (!interaction.channel.archived) {
                await interaction.channel.send('🔒 Both participants approved closing. A transcript will be sent after this conversation is archived.');
                await interaction.editReply({ embeds: [embed.setFooter({ text: 'Closure approved by both participants.' })], components: [] });
            }
            const result = await closeDealThread(options);
            await reportMetadataDelay(interaction, result);
        } catch (error) {
            if (interaction.channel.archived) {
                const result = await closeDealThread(options);
                await reportMetadataDelay(interaction, result);
                return;
            }
            console.warn('[CLOSE] Could not close deal thread:', error.message);
            await interaction.editReply({
                embeds: [embed.setFooter({ text: 'Closing failed. Check the bot permissions, then try Approve Close or Force Close again.' })],
                components: interaction.message?.components?.length ? interaction.message.components : [closeButtons(escrow.id)],
            });
        }
    },
};
