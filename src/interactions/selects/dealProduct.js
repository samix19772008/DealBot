const { getListingRequest } = require('../../database/listingRepository');
const { createCatalogResponse, createPaymentResponse } = require('../../utils/catalogPresentation');
const { deny } = require('../helpers');

module.exports = {
    id: 'deal_product_',
    async execute(interaction) {
        const match = interaction.customId.match(/^deal_product_v3_([a-f0-9]{32})_(\d{1,3})$/);
        if (!interaction.guildId || !match) return deny(interaction, 'This product menu has expired. Reopen Request a Deal on the source post.');
        const [, token, pageText] = match;
        let session;
        let payload;
        try {
            session = getListingRequest(token, { guildId: interaction.guildId, buyerDiscordId: interaction.user.id });
            if (interaction.values?.length !== 1) throw new Error('Choose one product or pack from the menu.');
            const value = interaction.values[0];
            if (/^page:\d{1,3}$/.test(value)) {
                const page = Number(value.slice('page:'.length));
                if (Math.abs(page - Number(pageText)) !== 1) throw new Error('Choose the previous or next product page from this menu.');
                payload = createCatalogResponse(session, page);
            } else {
                payload = createPaymentResponse(session, value);
            }
        } catch (error) {
            return deny(interaction, error.message);
        }
        return interaction.update(payload);
    },
};
