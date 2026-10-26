const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { showListingPreview } = require('../../utils/catalogPreview');

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName('Preview Listing')
        .setType(ApplicationCommandType.Message)
        .setDMPermission(false),
    async execute(interaction) {
        const message = interaction.targetMessage;
        if (!message?.author || message.author.bot) {
            return interaction.reply({ content: 'Preview a market post written by you.', ephemeral: true });
        }
        return showListingPreview(interaction, {
            channelId: message.channelId, messageId: message.id, authorId: message.author.id,
        });
    },
};
