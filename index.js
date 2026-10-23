require('dotenv').config({ quiet: true });
const { requireConfiguration } = require('./src/utils/config');

async function start() {
    requireConfiguration(['DISCORD_TOKEN']);
    const client = require('./src/client');
    const { loadCommands } = require('./src/handlers/commandHandler');
    const { loadEvents } = require('./src/handlers/eventHandler');
    const { loadButtons } = require('./src/handlers/buttonHandler');
    const { loadModals } = require('./src/handlers/modalHandler');
    require('./src/database/init').initDatabase();
    loadCommands(client);
    loadEvents(client);
    loadButtons(client);
    loadModals(client);
    client.on('error', error => console.error('[CLIENT] Discord error:', error.code ?? error.name));
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            client.destroy();
            require('./src/database/init').db.close();
        });
    }
    await client.login(process.env.DISCORD_TOKEN);
    return client;
}

if (require.main === module) start().catch(error => {
    console.error('[STARTUP]', error.message === 'An invalid token was provided.' ? 'Invalid Discord token. Update .env.' :
        error.message.startsWith('Missing configuration:') ? error.message : (error.code ?? error.name));
    process.exitCode = 1;
});

module.exports = { start };
