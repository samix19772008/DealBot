const { ContextMenuCommandBuilder, ApplicationCommandType, StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');
const { formatPayment } = require('../../utils/payments');
const { parseListing, listingFingerprint, LISTING_FORMAT_HELP } = require('../../utils/listings');
const { createListingRequest } = require('../../database/listingRepository');
const { getAccessibleSourceMessage } = require('../../interactions/selects/paymentMethod');

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName('Request a Deal')
        .setType(ApplicationCommandType.Message)
        .setDMPermission(false),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Request a deal from a message inside your server.', ephemeral: true });
        }
        const targetMessage = interaction.targetMessage;
        if (!targetMessage?.author) {
            return interaction.reply({ content: 'The source message is unavailable. Open the request again.', ephemeral: true });
        }
        if (targetMessage.author.bot) {
            return interaction.reply({ content: 'You cannot open a deal on a bot message.', ephemeral: true });
        }
        if (targetMessage.author.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot open a deal with yourself.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const source = await getAccessibleSourceMessage(interaction, targetMessage.channelId, targetMessage.id);
        if (source.error) return interaction.editReply({ content: source.error, allowedMentions: { parse: [] } });
        let listing;
        try { listing = parseListing(source.message.content); }
        catch {
            return interaction.editReply({
                content: `This post does not have clear, supported listing prices. Ask the seller to use this format before requesting a deal.\n\n${LISTING_FORMAT_HELP}`,
                allowedMentions: { parse: [] },
            });
        }
        const session = createListingRequest({
            guildId: interaction.guildId,
            channelId: source.message.channelId,
            messageId: source.message.id,
            buyerDiscordId: interaction.user.id,
            sellerDiscordId: source.message.author.id,
            listing,
            sourceFingerprint: listingFingerprint(source.message),
        });
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`deal_payment_method_v2_${session.token}`)
            .setPlaceholder('Choose the payment method')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(listing.options.map(method => ({
                label: method.label,
                value: method.key,
                description: `${formatPayment(method)} per product`.slice(0, 100),
            })));

        await interaction.editReply({
            content: 'Choose a payment method offered in this post. Enter the product quantity next; the total is calculated from the seller\'s fixed price. This request expires in 15 minutes.',
            components: [new ActionRowBuilder().addComponents(menu)],
            allowedMentions: { parse: [] },
        });
    },
};
