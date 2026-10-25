const { PermissionFlagsBits, ChannelType } = require('discord.js');

/** Recheck access before reading a source through the bot's wider permissions. */
async function getAccessibleSourceMessage(interaction, channelId, messageId) {
    if (!interaction.guildId || !interaction.guild || !interaction.member) {
        return { error: 'Open a new deal request from a message inside your server.' };
    }
    const channel = await interaction.guild.channels.fetch(channelId, { force: true }).catch(() => null);
    // Thread permissions are inherited from a cached parent. Refresh that
    // parent before checking access, even when the thread itself was fetched.
    if (channel?.parentId && (channel.isThread?.() ||
        [ChannelType.PrivateThread, ChannelType.PublicThread, ChannelType.AnnouncementThread].includes(channel.type))) {
        const parent = await interaction.guild.channels.fetch(channel.parentId, { force: true }).catch(() => null);
        if (!parent || parent.guildId !== interaction.guildId) {
            return { error: 'You can no longer access the source message. Open the deal request again from a message you can view.' };
        }
    }
    const permissions = channel?.permissionsFor?.(interaction.member);
    if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased?.() || !channel.messages ||
        !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return { error: 'You can no longer access the source message. Open the deal request again from a message you can view.' };
    }
    if (channel.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads)) {
        const membership = await channel.members.fetch({ member: interaction.user.id, force: true, cache: false }).catch(() => null);
        if (!membership) {
            return { error: 'You are no longer a member of the source private thread. Open a deal request from a message you can access.' };
        }
    }
    // A cached Message may still contain an edited or deleted seller price.
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false }).catch(() => null);
    if (!message?.author || String(message.id) !== String(messageId) || String(message.channelId) !== String(channelId)) {
        return { error: 'The source message could not be found. Open a new deal request.' };
    }
    if (message.author.bot) return { error: 'You cannot open a deal on a bot message.' };
    if (message.author.id === interaction.user.id) return { error: 'You cannot open a deal with yourself.' };
    return { message };
}

module.exports = { getAccessibleSourceMessage };
