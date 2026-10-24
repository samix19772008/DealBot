const { sendDealOffer } = require('../../utils/dealOffer');
const { PAYMENT_METHODS, resolvePayment } = require('../../utils/payments');
const { getAccessibleSourceMessage } = require('../selects/paymentMethod');
const { deny } = require('../helpers');
const { boundedText } = require('../../utils/validation');

module.exports = {
    id: 'deal_offer_modal_',
    async execute(interaction) {
        const match = interaction.customId.match(/^deal_offer_modal_([a-z0-9]+)_(\d{1,20})_(\d{1,20})_(\d{1,20})$/);
        if (!interaction.guildId || !match) {
            return deny(interaction, 'This deal form has expired. Reopen Request a Deal on the source message and choose a payment method.');
        }
        const [, methodKey, channelId, messageId, buyerId] = match;
        if (buyerId !== interaction.user.id) return deny(interaction, 'Only the person who opened this deal request can submit it.');
        const method = PAYMENT_METHODS.find(candidate => candidate.key === methodKey);
        if (!method) return deny(interaction, 'The payment method is invalid. Reopen Request a Deal and choose a payment method.');
        let payment;
        try {
            payment = resolvePayment({
                method: method.key,
                amount: interaction.fields.getTextInputValue('amount'),
                unit: method.key === 'money' ? 'each' : interaction.fields.getTextInputValue('payment_unit'),
            });
        } catch (error) {
            return deny(interaction, error.message);
        }

        await interaction.deferReply({ ephemeral: true });
        const source = await getAccessibleSourceMessage(interaction, channelId, messageId);
        if (source.error) return interaction.editReply({ content: source.error, allowedMentions: { parse: [] } });
        const targetMessage = source.message;
        const embedText = (targetMessage.embeds ?? [])
            .map(embed => [embed.title, embed.description].filter(value => typeof value === 'string' && value.trim()).join('\n'))
            .filter(Boolean).join('\n\n');
        const listingText = targetMessage.content?.trim() || embedText.trim();
        const itemDescription = boundedText(listingText || `Message attachment: ${targetMessage.url}`, 1000);
        await sendDealOffer({ interaction, sellerDiscordUser: targetMessage.author, itemDescription, ...payment });
    },
};
