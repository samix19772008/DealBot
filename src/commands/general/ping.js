const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    registered: false,
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDMPermission(false)
        .setDescription("Checks the bot's latency."),

    async execute(interaction) {
        const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;

        await interaction.editReply(
            `🏓 Pong! Latency: ${latency}ms | API: ${Math.round(interaction.client.ws.ping)}ms`
        );
    },
};