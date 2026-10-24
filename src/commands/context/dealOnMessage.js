const { ContextMenuCommandBuilder, ApplicationCommandType, StringSelectMenuBuilder, ActionRowBuilder } = require('discord.js');
const { PAYMENT_METHODS } = require('../../utils/payments');

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

        const menu = new StringSelectMenuBuilder()
            .setCustomId(`deal_payment_method_${targetMessage.channelId}_${targetMessage.id}_${interaction.user.id}`)
            .setPlaceholder('Choose the payment method')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(PAYMENT_METHODS.map(method => ({ label: method.label, value: method.key })));

        await interaction.reply({
            content: 'Choose one payment method agreed with the seller. Enter the total payment next, not the quantity of the item you are buying.',
            components: [new ActionRowBuilder().addComponents(menu)],
            ephemeral: true,
            allowedMentions: { parse: [] },
        });
    },
};
