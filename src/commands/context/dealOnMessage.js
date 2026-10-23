const { ContextMenuCommandBuilder, ApplicationCommandType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName('Request a Deal')
        .setType(ApplicationCommandType.Message)
        .setDMPermission(false),

    async execute(interaction) {
        const targetMessage = interaction.targetMessage;

        if (targetMessage.author.bot) {
            return interaction.reply({ content: 'You cannot open a deal on a bot message.', ephemeral: true });
        }

        if (targetMessage.author.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot open a deal with yourself.', ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId(`deal_offer_modal_${targetMessage.channelId}_${targetMessage.id}`)
            .setTitle('Deal Details');

        const amountInput = new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('Amount (numbers only)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Example: 25.50')
            .setMaxLength(13)
            .setRequired(true);

        const currencyInput = new TextInputBuilder()
            .setCustomId('currency')
            .setLabel('Currency or payment unit')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Example: gold or USD')
            .setMaxLength(24)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(amountInput),
            new ActionRowBuilder().addComponents(currencyInput),
        );

        await interaction.showModal(modal);
    },
};