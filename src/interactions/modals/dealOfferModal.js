const { sendDealOffer } = require('../../utils/dealOffer');
const { getListingQuote } = require('../../database/listingRepository');
const { listingFingerprint } = require('../../utils/listings');
const { getAccessibleSourceMessage } = require('../../utils/sourceMessage');
const { deny } = require('../helpers');

module.exports = {
    id: 'deal_offer_modal_',
    async execute(interaction) {
        const legacy = interaction.customId.match(/^deal_offer_modal_v2_([a-f0-9]{32})_([a-z0-9]+)$/);
        const current = interaction.customId.match(/^deal_offer_modal_v3_([a-f0-9]{32})_(p\d{1,3})_([a-z0-9]+)$/);
        const match = current || legacy;
        if (!interaction.guildId || !match) {
            return deny(interaction, 'This deal form has expired. Reopen Request a Deal on the source message and choose a payment method.');
        }
        const token = match[1];
        const productId = current?.[2];
        const methodKey = current ? current[3] : legacy[2];
        let quote;
        try {
            const quantity = interaction.fields.getTextInputValue('quantity');
            if (!/^[1-9]\d{0,2}$/.test(quantity)) throw new Error('Enter a whole product quantity from 1 to 999.');
            quote = getListingQuote(token, {
                guildId: interaction.guildId,
                buyerDiscordId: interaction.user.id,
                productId,
                methodKey,
                quantity: Number(quantity),
            });
        } catch (error) {
            return deny(interaction, error.message);
        }

        await interaction.deferReply({ ephemeral: true });
        const { session, payment, itemDescription } = quote;
        const source = await getAccessibleSourceMessage(interaction, session.channel_id, session.message_id);
        if (source.error) return interaction.editReply({ content: source.error, allowedMentions: { parse: [] } });
        const targetMessage = source.message;
        const unchanged = targetMessage.author.id === session.seller_discord_id &&
            listingFingerprint(targetMessage) === session.source_fingerprint;
        if (!unchanged) {
            return interaction.editReply({
                content: 'The source post changed after this request was opened. Reopen Request a Deal to review the current prices.',
                allowedMentions: { parse: [] },
            });
        }
        await sendDealOffer({
            interaction, sellerDiscordUser: targetMessage.author, itemDescription, ...payment,
            listingRequest: { token, productId, methodKey, quantity: payment.quantity },
        });
    },
};
