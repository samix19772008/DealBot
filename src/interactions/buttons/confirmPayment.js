const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { markAsFunded } = require('../../database/escrowRepository');
const { buildDealEmbed } = require('../../utils/embedTemplate');
const { deny, getScopedDeal, confirmedEmbed } = require('../helpers');

module.exports = {
    id: 'confirm_payment_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (interaction.user.id !== escrow.buyer_discord_id) return deny(interaction, 'Only the buyer can confirm payment on this deal.');
        if (escrow.status !== 'awaiting_payment') return deny(interaction, `This deal is ${escrow.status}; payment cannot be confirmed now.`);
        await interaction.deferUpdate();
        if (!markAsFunded(escrow.id, interaction.user.id)) return deny(interaction, 'This deal changed. Check its current status before continuing.');
        await interaction.editReply({
            embeds: [confirmedEmbed(interaction, `Payment reported by ${interaction.user.tag} • Not independently verified`)], components: [],
        });
        const embed = buildDealEmbed({
            title: 'Step 2: Confirm Delivery', referenceId: escrow.transaction_uuid, status: 'pending',
            rows: [{ label: 'Seller Action', value: `<@${escrow.seller_discord_id}>, verify the payment in your own account, then deliver the agreed item or service and confirm below.` }],
            footerNote: 'The bot tracks confirmations. It does not hold funds or verify payments.',
        });
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`confirm_delivery_${escrow.id}`).setLabel('Confirm Delivery').setStyle(ButtonStyle.Primary).setEmoji('📦'),
        );
        await interaction.channel.send({ embeds: [embed], components: [buttons] });
    },
};
