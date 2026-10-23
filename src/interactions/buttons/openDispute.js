const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { getGuildSettings } = require('../../database/guildSettingsRepository');
const { deny, getScopedDeal, isParticipant } = require('../helpers');

module.exports = {
    id: 'open_dispute_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isParticipant(interaction, escrow)) return deny(interaction, 'Only the buyer or seller can open a dispute.');
        if (!['awaiting_payment', 'funded', 'delivered'].includes(escrow.status)) {
            return deny(interaction, `This deal is ${escrow.status}; a new dispute cannot be opened.`);
        }
        if (!getGuildSettings(escrow.guild_id)?.moderator_role_id) {
            return deny(interaction, 'A server administrator must configure a moderator role with /set-mod-role before disputes can be opened.');
        }
        const reason = new TextInputBuilder()
            .setCustomId('reason').setLabel('What went wrong?')
            .setPlaceholder('Describe the problem and any relevant evidence. Do not include passwords.')
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(10).setMaxLength(1000);
        const modal = new ModalBuilder()
            .setCustomId(`dispute_reason_modal_${escrow.id}`).setTitle('Open a Dispute')
            .addComponents(new ActionRowBuilder().addComponents(reason));
        await interaction.showModal(modal);
    },
};
