const { SlashCommandBuilder } = require('discord.js');
const { sendDealOffer } = require('../../utils/dealOffer');
const { parsePrice, validateDealInput } = require('../../utils/validation');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deal')
        .setDescription('Send an escrow request to a seller')
        .setDMPermission(false)
        .addUserOption(option => option
            .setName('seller').setDescription('The seller you want to deal with').setRequired(true))
        .addStringOption(option => option
            .setName('item').setDescription('Description of the item or service')
            .setMinLength(1).setMaxLength(1000).setRequired(true))
        .addStringOption(option => option
            .setName('price').setDescription('Amount and currency, for example: 50 gold or 12.50 USD')
            .setMinLength(3).setMaxLength(48).setRequired(true)),

    async execute(interaction) {
        let details;
        try {
            details = validateDealInput({
                itemDescription: interaction.options.getString('item'),
                ...parsePrice(interaction.options.getString('price')),
            });
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
