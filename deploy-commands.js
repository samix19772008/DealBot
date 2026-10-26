require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');
const { requireConfiguration } = require('./src/utils/config');
const { loadCommands } = require('./src/handlers/commandHandler');

function commandDefinitions() {
    const holder = {};
    loadCommands(holder);
    return [...holder.commands.values()].filter(command => command.registered !== false)
        .map(command => command.data.toJSON());
}

function deploymentOptions(argv = process.argv.slice(2)) {
    const unknown = argv.filter(argument => !['--dry-run', '--global'].includes(argument));
    if (unknown.length) throw new Error('Use --dry-run to validate offline and --global to register for all installed servers.');
    return { dryRun: argv.includes('--dry-run'), scope: argv.includes('--global') ? 'global' : 'guild' };
}

async function deployCommands({
    argv = process.argv.slice(2), values = process.env, restClient,
    definitions = commandDefinitions, log = console.log,
} = {}) {
    const { dryRun, scope } = deploymentOptions(argv);
    const commands = definitions();
    if (dryRun) {
        log(`Validated ${commands.length} ${scope} command definitions: ${commands.map(command => command.name).join(', ')}`);
        return commands;
    }
    requireConfiguration(scope === 'global'
        ? ['DISCORD_TOKEN', 'CLIENT_ID']
        : ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'], values);
    const rest = restClient ?? new REST().setToken(values.DISCORD_TOKEN);
    const route = scope === 'global'
        ? Routes.applicationCommands(values.CLIENT_ID)
        : Routes.applicationGuildCommands(values.CLIENT_ID, values.GUILD_ID);
    await rest.put(route, { body: commands });
    log(`Registered ${commands.length} ${scope} commands successfully.`);
    return commands;
}

if (require.main === module) deployCommands().catch(error => {
    const message = error.message || '';
    console.error('[COMMANDS]', message.startsWith('Missing configuration:') || message.includes('numeric ID') ||
        message.startsWith('Use --dry-run') ? message : (error.code ?? error.name));
    process.exitCode = 1;
});

module.exports = { commandDefinitions, deploymentOptions, deployCommands };
