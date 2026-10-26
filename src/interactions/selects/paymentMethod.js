const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { getListingRequest } = require('../../database/listingRepository');
const { getAccessibleSourceMessage } = require('../../utils/sourceMessage');
const { getCatalogProduct } = require('../../utils/catalogPresentation');
const { deny } = require('../helpers');

module.exports = {
    id: 'deal_payment_method_',
    async execute(interaction) {
        const legacy = interaction.customId.match(/^deal_payment_method_v2_([a-f0-9]{32})$/);
        const current = interaction.customId.match(/^deal_payment_method_v3_([a-f0-9]{32})_(p\d{1,3})$/);
        const match = current || legacy;
        if (!match || !interaction.guildId) return deny(interaction, 'This payment menu has expired. Reopen Request a Deal on the source post.');
        const [, token] = match;
        let session;
        let product;
        try {
            session = getListingRequest(token, { guildId: interaction.guildId, buyerDiscordId: interaction.user.id });
            product = getCatalogProduct(session, current?.[2]);
            if (product.stock === 0) throw new Error('This product or pack is advertised as sold out. Choose another offer or ask the seller to update the post.');
        }
        catch (error) { return deny(interaction, error.message); }
        const method = interaction.values?.length === 1
            ? product.options.find(candidate => candidate.key === interaction.values[0])
            : null;
        if (!method) return deny(interaction, 'Choose a payment method offered in the source post. Reopen Request a Deal if the post has changed.');

        // A modal must be the initial interaction response. Revalidate source access
        // after the submitted form is deferred, instead of delaying this response.
        const modal = new ModalBuilder()
            .setCustomId(current ? `deal_offer_modal_v3_${token}_${product.id}_${method.key}` : `deal_offer_modal_v2_${token}_${method.key}`)
            .setTitle(`${method.label} Deal`);
        const quantity = new TextInputBuilder()
            .setCustomId('quantity')
            .setLabel(product.bundleQuantity > 1 ? 'Number of packs (1 to 999)' : 'Product quantity (1 to 999)')
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
