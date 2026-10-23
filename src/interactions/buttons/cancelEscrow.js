const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { deny, getScopedDeal, isParticipant } = require('../helpers');

module.exports = {
    id: 'cancel_escrow_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length), { allowDm: true });
        if (!escrow) return;
        if (!isParticipant(interaction, escrow)) {
            return deny(interaction, 'Only the buyer or seller can cancel this deal.');
        }
        if (escrow.status !== 'pending') {
            return deny(interaction, `This deal is already ${escrow.status}. Use the dispute button in its private conversation if you need help.`);
        }
        const reasonInput = new TextInputBuilder()
            .setCustomId('reason').setLabel('Reason for cancellation (optional)')
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300);
        const modal = new ModalBuilder()
            .setCustomId(`cancel_reason_modal_${escrow.id}`).setTitle('Cancel Deal')
            .addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
    },
};
