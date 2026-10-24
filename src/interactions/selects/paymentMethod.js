const { PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { PAYMENT_METHODS } = require('../../utils/payments');
const { deny } = require('../helpers');

/** Recheck access before reading a message through the bot's wider permissions. */
async function getAccessibleSourceMessage(interaction, channelId, messageId) {
    if (!interaction.guildId || !interaction.guild || !interaction.member) {
        return { error: 'Open a new deal request from a message inside your server.' };
    }
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const permissions = channel?.permissionsFor?.(interaction.member);
    if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased?.() || !channel.messages ||
        !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return { error: 'You can no longer access the source message. Open the deal request again from a message you can view.' };
    }
    if (channel.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads)) {
        const membership = await channel.members.fetch(interaction.user.id).catch(() => null);
        if (!membership) {
            return { error: 'You are no longer a member of the source private thread. Open a deal request from a message you can access.' };
        }
    }
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message?.author) return { error: 'The source message could not be found. Open a new deal request.' };
    if (message.author.bot) return { error: 'You cannot open a deal on a bot message.' };
    if (message.author.id === interaction.user.id) return { error: 'You cannot open a deal with yourself.' };
    return { message };
}

module.exports = {
    id: 'deal_payment_method_',
    async execute(interaction) {
        const match = interaction.customId.match(/^deal_payment_method_(\d{1,20})_(\d{1,20})_(\d{1,20})$/);
        if (!match || !interaction.guildId) return deny(interaction, 'Open a new deal request from a message inside your server.');
        const [, channelId, messageId, buyerId] = match;
        if (buyerId !== interaction.user.id) return deny(interaction, 'Only the person who opened this deal request can choose its payment method.');
        const method = interaction.values?.length === 1
            ? PAYMENT_METHODS.find(candidate => candidate.key === interaction.values[0])
            : null;
        if (!method) return deny(interaction, 'Choose Money, Golds, Redblocks, or Sky 1 Notchs from the payment menu.');

        // A modal must be the initial interaction response. Revalidate source access
        // after the submitted form is deferred, instead of delaying this response.
        const modal = new ModalBuilder()
            .setCustomId(`deal_offer_modal_${method.key}_${channelId}_${messageId}_${buyerId}`)
            .setTitle(`${method.label} Deal`);
        const amount = new TextInputBuilder()
            .setCustomId('amount')
            .setLabel(method.key === 'money' ? 'Total payment in USD' : 'Total payment (whole items or stacks)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(method.key === 'money' ? 'Example: 25.50' : 'Example: 25')
            .setMaxLength(13)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(amount));
        if (method.key !== 'money') {
            const unit = new TextInputBuilder()
                .setCustomId('payment_unit')
                .setLabel('Unit: each or stacks (optional)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('each (default) or stacks (64 each)')
                .setMaxLength(6)
                .setRequired(false);
            modal.addComponents(new ActionRowBuilder().addComponents(unit));
        }
        await interaction.showModal(modal);
    },
    getAccessibleSourceMessage,
};
