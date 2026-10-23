require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Clearing all global commands...');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: [] },
        );

        console.log('Global commands cleared successfully.');
    } catch (error) {
        console.error(error);
    }
})();