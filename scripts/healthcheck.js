const fs = require('node:fs');
const { healthStatusPath, inspectHealth, queueMetrics } = require('../src/services/runtimeHealth');

function checkHealth({ filename = healthStatusPath(), ...options } = {}) {
    try {
        const metadata = fs.statSync(filename);
        if (!metadata.isFile() || metadata.size > 16384) return { healthy: false, reason: 'The runtime heartbeat file is invalid.' };
        const status = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const result = inspectHealth(status, options);
        const counts = queueMetrics(status.transcriptQueue);
        return { ...result, ...(counts ? { transcriptQueue: counts } : {}) };
    } catch {
        return { healthy: false, reason: 'No readable runtime heartbeat is available. Start the bot and check its logs.' };
    }
}

function runCli(args = process.argv.slice(2)) {
    if (args.length === 1 && args[0] === '--help') {
        console.log('Usage: node scripts/healthcheck.js');
        console.log('Checks HEALTH_STATUS_PATH or the database folder\'s health.json. Requires a live process, a fresh heartbeat, and last-reported Discord readiness. Does not log in or contact Discord.');
        return;
    }
    if (args.length) throw new Error('Usage: node scripts/healthcheck.js');
    require('dotenv').config({ quiet: true });
    const result = checkHealth();
    console.log(`[HEALTH] ${result.reason}`);
    if (result.transcriptQueue) console.log(`[TRANSCRIPT QUEUE] ${JSON.stringify(result.transcriptQueue)}`);
    process.exitCode = result.healthy ? 0 : 1;
}

if (require.main === module) {
    try { runCli(); }
    catch (error) { console.error('[HEALTH]', error.message); process.exitCode = 1; }
}

module.exports = { checkHealth, runCli };
