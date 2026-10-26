const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { sendDealOffer } = require('../../utils/dealOffer');
const { validateDealInput } = require('../../utils/validation');
const { resolvePayment } = require('../../utils/payments');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deal')
        .setDescription('Start buying from a seller\'s post or open your private deals')
        .setDMPermission(false),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Open /deal inside your marketplace server.', ephemeral: true, allowedMentions: { parse: [] } });
        }
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Buy from a Market Post')
            .setDescription('**1.** Right-click the seller\'s post, or open its message menu on mobile.\n**2.** Choose **Apps → Request a Deal**.\n**3.** Select the product, payment option, and quantity.\n\nDealBot calculates the price from the post and sends your request to the seller. After acceptance, follow the buttons in your private conversation.')
            .addFields({ name: 'Already have a deal?', value: 'Open **My Deals** below to see your requests, next actions, and conversations.' })
            .setFooter({ text: 'DealBot tracks confirmations and records. It does not hold or verify payments.' });
        const controls = new ActionRowBuilder().addComponents(new ButtonBuilder()
            .setCustomId(`deals_page_${interaction.guildId}:${interaction.user.id}:active:1:refresh`)
            .setLabel('My Deals').setStyle(ButtonStyle.Primary));
        return interaction.reply({ embeds: [embed], components: [controls], ephemeral: true, allowedMentions: { parse: [] } });
    },
    executeLegacyRequest,
};

// Kept for offline compatibility checks of the shared offer flow. It is not a
// registered command or an interaction route; buyers use the source post.
async function executeLegacyRequest(interaction) {
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
            allowPublicOffer: interaction.options.getBoolean?.('public-offer') ?? false,
            ...details,
        });
}
