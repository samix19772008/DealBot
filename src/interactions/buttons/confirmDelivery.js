const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { markAsDelivered } = require('../../database/escrowRepository');
const { buildDealEmbed } = require('../../utils/embedTemplate');
const { deny, getScopedDeal, confirmedEmbed } = require('../helpers');

module.exports = {
    id: 'confirm_delivery_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (interaction.user.id !== escrow.seller_discord_id) return deny(interaction, 'Only the seller can confirm delivery on this deal.');
        if (escrow.status !== 'funded') return deny(interaction, `This deal is ${escrow.status}; delivery cannot be confirmed now.`);
        await interaction.deferUpdate();
        if (!markAsDelivered(escrow.id, interaction.user.id)) return deny(interaction, 'This deal changed. Check its current status before continuing.');
        await interaction.editReply({ embeds: [confirmedEmbed(interaction, `Delivery confirmed by ${interaction.user.tag}`)], components: [] });
        const embed = buildDealEmbed({
            title: 'Step 3: Confirm Receipt', referenceId: escrow.transaction_uuid, status: 'pending',
            rows: [{ label: 'Buyer Action', value: `<@${escrow.buyer_discord_id}>, inspect the delivered item or service. Confirm only when everything matches the agreement. If there is a problem, open a dispute instead.` }],
            footerNote: 'Confirming receipt completes the deal and updates both trust records.',
        });
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`confirm_receipt_${escrow.id}`).setLabel('Confirm Receipt & Complete').setStyle(ButtonStyle.Success).setEmoji('✅'),
        );
        await interaction.channel.send({ embeds: [embed], components: [buttons] });
    },
};
