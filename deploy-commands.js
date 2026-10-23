require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');
const { requireConfiguration } = require('./src/utils/config');
const { loadCommands } = require('./src/handlers/commandHandler');

function commandDefinitions() {
    const holder = {};
    loadCommands(holder);
    return [...holder.commands.values()].map(command => command.data.toJSON());
}

async function deployCommands() {
    const commands = commandDefinitions();
    // Validate command definitions offline without using credentials or HTTP.
    if (process.argv.includes('--dry-run')) {
        console.log(`Validated ${commands.length} server command definitions: ${commands.map(command => command.name).join(', ')}`);
        return commands;
    }
    requireConfiguration(['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']);
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} commands successfully.`);
    return commands;
}

if (require.main === module) deployCommands().catch(error => {
    console.error('[COMMANDS]', error.message.startsWith('Missing configuration:') || error.message.includes('numeric ID')
        ? error.message : (error.code ?? error.name));
    process.exitCode = 1;
});

module.exports = { commandDefinitions, deployCommands };
