const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { parseCatalog } = require('../../utils/catalog');
const { listingFingerprint } = require('../../utils/listings');
const { createListingRequest } = require('../../database/listingRepository');
const { getAccessibleSourceMessage } = require('../../utils/sourceMessage');
const { createCatalogResponse, createPaymentResponse } = require('../../utils/catalogPresentation');

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
        let catalog;
        try { catalog = parseCatalog(source.message.content); }
        catch (error) {
            return interaction.editReply({
                content: `The products and prices in this post could not be identified safely. ${error.message || 'Ask the seller to clarify the product names and prices.'}`.slice(0, 1900),
                components: [],
                allowedMentions: { parse: [] },
            });
        }
        if (!catalog.products.some(product => product.stock !== 0)) {
            return interaction.editReply({ content: 'The products in this post are advertised as sold out. Ask the seller to update their stock before requesting a deal.',
                components: [], allowedMentions: { parse: [] } });
        }
        const session = createListingRequest({
            guildId: interaction.guildId,
            channelId: source.message.channelId,
            messageId: source.message.id,
            buyerDiscordId: interaction.user.id,
            sellerDiscordId: source.message.author.id,
            catalog,
            sourceContent: source.message.content,
            sourceFingerprint: listingFingerprint(source.message),
        });
        return interaction.editReply(catalog.products.length === 1
            ? createPaymentResponse(session, catalog.products[0].id)
            : createCatalogResponse(session));
    },
};
