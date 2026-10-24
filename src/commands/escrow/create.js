const { SlashCommandBuilder } = require('discord.js');
const { sendDealOffer } = require('../../utils/dealOffer');
const { validateDealInput } = require('../../utils/validation');
const { PAYMENT_METHODS, resolvePayment } = require('../../utils/payments');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deal')
        .setDescription('Buy a listed item using one agreed payment method')
        .setDMPermission(false)
        .addUserOption(option => option
            .setName('seller').setDescription('The seller you want to deal with').setRequired(true))
        .addStringOption(option => option
            .setName('item').setDescription('The listed item or service you are buying')
            .setMinLength(1).setMaxLength(1000).setRequired(true))
        .addStringOption(option => option
            .setName('payment').setDescription('Choose one method offered by the seller').setRequired(true)
            .addChoices(...PAYMENT_METHODS.map(method => ({ name: method.label, value: method.key }))))
        .addNumberOption(option => option
            .setName('amount').setDescription('Total agreed payment, not the quantity of the item you are buying')
            .setMinValue(0.01).setMaxValue(9999999999.99).setRequired(true))
        .addStringOption(option => option
            .setName('unit').setDescription('For game payments: individual items or stacks of 64 (default: Each)')
            .addChoices({ name: 'Each', value: 'each' }, { name: 'Stacks (64 each)', value: 'stacks' })),

    async execute(interaction) {
        let details;
        try {
            const payment = resolvePayment({
                method: interaction.options.getString('payment'),
                amount: interaction.options.getNumber('amount'),
                unit: interaction.options.getString('unit') ?? 'each',
            });
            details = {
                ...validateDealInput({ itemDescription: interaction.options.getString('item'), ...payment }),
                paymentUnit: payment.paymentUnit,
            };
        } catch (error) {
            return interaction.reply({ content: error.message, ephemeral: true });
        }
        return sendDealOffer({
            interaction,
            sellerDiscordUser: interaction.options.getUser('seller'),
            ...details,
        });
    },
};
