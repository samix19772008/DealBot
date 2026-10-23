const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { setHubChannel } = require('../../database/guildSettingsRepository');

const REQUIRED = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Send Messages', PermissionFlagsBits.SendMessages],
    ['Create Private Threads', PermissionFlagsBits.CreatePrivateThreads],
    ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads],
    ['Manage Threads', PermissionFlagsBits.ManageThreads],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
    ['Embed Links', PermissionFlagsBits.EmbedLinks],
    ['Attach Files', PermissionFlagsBits.AttachFiles],
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-hub-channel')
        .setDescription('Choose and validate the channel used for private escrow threads')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(option => option
            .setName('channel').setDescription('A regular text channel visible to deal participants')
            .addChannelTypes(ChannelType.GuildText).setRequired(true)),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can set the escrow hub.', ephemeral: true });
        }
        const channel = interaction.options.getChannel('channel');
        if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guildId) {
            return interaction.reply({ content: 'Choose a regular text channel in this server.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
        const permissions = channel.permissionsFor(me);
        const missing = REQUIRED.filter(([, flag]) => !permissions?.has(flag)).map(([name]) => name);
        if (missing.length) {
            return interaction.editReply(`I need these permissions in the chosen channel: **${missing.join(', ')}**. Update the channel permissions and try again.`);
        }
        setHubChannel(interaction.guildId, channel.id);
        return interaction.editReply(`✅ <#${channel.id}> is now the escrow hub. Private threads will be visible only to their participants and staff with Manage Threads. Participants also need View Channel and Read Message History on this hub.`);
    },
};
