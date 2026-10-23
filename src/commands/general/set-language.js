const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setLanguage } = require('../../database/guildSettingsRepository');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-language')
        .setDescription('Use English for every DealBot message in this server')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => option
            .setName('language').setDescription('Bot language').setRequired(true)
            .addChoices({ name: 'English', value: 'en' })),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can change the bot language.', ephemeral: true });
        }
        setLanguage(interaction.guildId, 'en');
        return interaction.reply({ content: '✅ DealBot uses English for all messages, commands, and buttons.', ephemeral: true });
    },
};
