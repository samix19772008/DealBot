const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { getListingRequest } = require('../../database/listingRepository');
const { getAccessibleSourceMessage } = require('../../utils/sourceMessage');
const { deny } = require('../helpers');

module.exports = {
    id: 'deal_payment_method_',
    async execute(interaction) {
        const match = interaction.customId.match(/^deal_payment_method_v2_([a-f0-9]{32})$/);
        if (!match || !interaction.guildId) return deny(interaction, 'This payment menu has expired. Reopen Request a Deal on the source post.');
        const [, token] = match;
        let session;
        try { session = getListingRequest(token, { guildId: interaction.guildId, buyerDiscordId: interaction.user.id }); }
        catch (error) { return deny(interaction, error.message); }
        const method = interaction.values?.length === 1
            ? session.listing.options.find(candidate => candidate.key === interaction.values[0])
            : null;
        if (!method) return deny(interaction, 'Choose a payment method offered in the source post. Reopen Request a Deal if the post has changed.');

        // A modal must be the initial interaction response. Revalidate source access
        // after the submitted form is deferred, instead of delaying this response.
        const modal = new ModalBuilder()
            .setCustomId(`deal_offer_modal_v2_${token}_${method.key}`)
            .setTitle(`${method.label} Deal`);
        const quantity = new TextInputBuilder()
            .setCustomId('quantity')
            .setLabel('Product quantity (1 to 999)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1')
            .setValue('1')
            .setMaxLength(3)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(quantity));
        await interaction.showModal(modal);
    },
    getAccessibleSourceMessage,
};
