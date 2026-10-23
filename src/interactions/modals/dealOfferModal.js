const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { sendDealOffer } = require('../../utils/dealOffer');
const { parseAmount } = require('../../utils/validation');
const { deny } = require('../helpers');

module.exports = {
    id: 'deal_offer_modal_',
    async execute(interaction) {
        const match = interaction.customId.match(/^deal_offer_modal_(\d+)_(\d+)$/);
        if (!interaction.guildId || !match) return deny(interaction, 'Open deal requests from a message in a server.');
        let amount;
        try {
            amount = parseAmount(interaction.fields.getTextInputValue('amount'));
        } catch (error) {
            return deny(interaction, error.message);
        }
        const currency = interaction.fields.getTextInputValue('currency')?.trim();
        if (!currency || currency.length > 24) return deny(interaction, 'The currency or payment unit must contain 1 to 24 characters.');
        await interaction.deferReply({ ephemeral: true });
        const [, channelId, messageId] = match;
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased?.() || !channel.messages ||
            !channel.permissionsFor(interaction.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
            return interaction.editReply({ content: 'You can no longer access the source message. Open the deal request again from a message you can view.' });
        }
        if (channel.type === ChannelType.PrivateThread &&
            !channel.permissionsFor(interaction.member).has(PermissionFlagsBits.ManageThreads)) {
            const membership = await channel.members.fetch(interaction.user.id).catch(() => null);
            if (!membership) return interaction.editReply({ content: 'You are no longer a member of the source private thread. Open a deal request from a message you can access.' });
        }
        const targetMessage = await channel.messages.fetch(messageId).catch(() => null);
        if (!targetMessage) return interaction.editReply({ content: 'The source message could not be found. Open a new deal request.' });
        const itemDescription = targetMessage.content?.trim().slice(0, 1000) || `Message attachment: ${targetMessage.url}`;
        await sendDealOffer({ interaction, sellerDiscordUser: targetMessage.author, itemDescription, amount, currency });
    },
};
