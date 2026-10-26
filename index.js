require('dotenv').config({ quiet: true });
const { requireConfiguration } = require('./src/utils/config');

async function start() {
    requireConfiguration(['DISCORD_TOKEN']);
    const { backupIntervalMs, startBackupMaintenance } = require('./src/services/backupMaintenance');
    const backupInterval = backupIntervalMs();
    const client = require('./src/client');
    const { loadCommands } = require('./src/handlers/commandHandler');
    const { loadEvents, drainClientEvents } = require('./src/handlers/eventHandler');
    const { loadButtons } = require('./src/handlers/buttonHandler');
    const { loadModals } = require('./src/handlers/modalHandler');
    const { loadSelects } = require('./src/handlers/selectHandler');
    const { db, DB_PATH, initDatabase } = require('./src/database/init');
    let stopOfferMaintenance = () => {};
    let stopTranscriptMaintenance = async () => {};
    let stopBackupMaintenance = async () => {};
    let stopHealth = () => {};
    const shutdown = require('./src/services/runtimeLifecycle').createShutdown({
        client,
        stopEarly: [() => stopHealth(), () => stopOfferMaintenance()],
        drain: () => drainClientEvents(client),
        stopLate: [() => stopTranscriptMaintenance(), () => stopBackupMaintenance()],
        closeDatabase: () => { if (db.open) db.close(); },
    });
    const signalHandlers = new Map();
    for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => {
            shutdown().then(result => { if (result.failed) process.exitCode = 1; })
                .catch(() => { process.exitCode = 1; });
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
    }
    try {
        initDatabase();
        loadCommands(client);
        loadEvents(client);
        loadButtons(client);
        loadModals(client);
        loadSelects(client);
        client.on('error', error => console.error('[CLIENT] Discord error:', error.code ?? error.name));
        await client.login(process.env.DISCORD_TOKEN);
        if (client.dealBotStopping) return client;
        stopOfferMaintenance = require('./src/services/offerMaintenance').startOfferMaintenance();
        stopTranscriptMaintenance = require('./src/services/transcriptMaintenance').startTranscriptMaintenance({ client });
        stopBackupMaintenance = startBackupMaintenance({ sourcePath: DB_PATH, intervalMs: backupInterval });
        stopHealth = require('./src/services/runtimeHealth').startRuntimeHealth({ client, getMetrics: () => ({
            ...require('./src/services/transcripts').getTranscriptQueueStats(),
            unavailableArchives: db.prepare("SELECT COUNT(*) AS count FROM transcript_delivery_archives WHERE generation_status = 'unavailable'").get().count,
        }) });
    } catch (error) {
        await shutdown();
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
        throw error;
    }
    return client;
}

if (require.main === module) start().catch(error => {
    console.error('[STARTUP]', error.message === 'An invalid token was provided.' ? 'Invalid Discord token. Update .env.' :
        /^(?:Missing configuration:|BACKUP_INTERVAL_HOURS)/.test(error.message) ? error.message : (error.code ?? error.name));
    process.exitCode = 1;
});

module.exports = { start };
