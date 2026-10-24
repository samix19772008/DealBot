require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');
const { requireConfiguration } = require('./src/utils/config');

async function clearGlobalCommands({
    argv = process.argv.slice(2), values = process.env, restClient, log = console.log,
} = {}) {
    if (argv.length !== 1 || argv[0] !== '--confirm') {
        throw new Error('Clearing commands affects every installed server. Run this script with --confirm only when you intend to remove all global commands.');
    }
    requireConfiguration(['DISCORD_TOKEN', 'CLIENT_ID'], values);
    const rest = restClient ?? new REST().setToken(values.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(values.CLIENT_ID), { body: [] });
    log('Global commands cleared successfully.');
}

if (require.main === module) clearGlobalCommands().catch(error => {
    const message = error.message || '';
    console.error('[COMMANDS]', message.startsWith('Clearing commands') || message.startsWith('Missing configuration:') ||
        message.includes('numeric ID') ? message : (error.code ?? error.name));
    process.exitCode = 1;
});

module.exports = { clearGlobalCommands };
