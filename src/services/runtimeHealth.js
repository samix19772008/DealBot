const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_MAX_AGE_MS = 60_000;

function queueMetrics(value) {
    if (!value || typeof value !== 'object') return undefined;
    const result = {};
    for (const key of ['pendingRecipients', 'failedRecipients', 'pendingArchives', 'unavailableArchives']) {
        if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
    }
    return Object.keys(result).length ? result : undefined;
}

function healthStatusPath(values = process.env) {
    if (values.HEALTH_STATUS_PATH?.trim()) return path.resolve(values.HEALTH_STATUS_PATH.trim());
    const database = values.DATABASE_PATH?.trim();
    return path.join(database && database !== ':memory:' ? path.dirname(path.resolve(database)) : path.join(__dirname, '..', '..', 'data'), 'health.json');
}

function inspectHealth(status, { now = Date.now(), maxAgeMs = HEALTH_MAX_AGE_MS, isAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
} } = {}) {
    if (!status || status.version !== 1 || !Number.isSafeInteger(status.pid) || status.pid <= 0 ||
        !Number.isSafeInteger(status.heartbeatAt) || status.heartbeatAt < 0 ||
        !Number.isSafeInteger(status.startedAt) || status.startedAt < 0) {
        return { healthy: false, reason: 'The runtime heartbeat is invalid.' };
    }
    if (status.heartbeatAt > now + 5000 || status.startedAt > status.heartbeatAt || now - status.heartbeatAt > maxAgeMs) {
        return { healthy: false, reason: 'The runtime heartbeat is stale or its clock is invalid.' };
    }
    if (!isAlive(status.pid)) return { healthy: false, reason: 'The recorded bot process is not running.' };
    if (status.stopping === true || status.discordReady !== true) {
        return { healthy: false, reason: 'The bot is stopping or Discord is not ready.' };
    }
    return { healthy: true, reason: 'The bot process has a fresh heartbeat and last reported Discord ready.' };
}

/** No timer or filesystem write occurs until explicitly started by the live bot. */
function startRuntimeHealth({ client, statusPath = healthStatusPath(), intervalMs = HEALTH_INTERVAL_MS,
    now = Date.now, schedule = setInterval, cancel = clearInterval, logger = console, getMetrics } = {}) {
    if (!client || typeof client.isReady !== 'function') throw new Error('A Discord client is required for runtime health.');
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || typeof statusPath !== 'string' || !statusPath.trim()) {
        throw new Error('Runtime health requires a file path and a positive heartbeat interval.');
    }
    const filename = path.resolve(statusPath);
    const startedAt = now();
    let stopped = false;
    function write() {
        let temporary;
        try {
            fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
            const status = { version: 1, pid: process.pid, startedAt, heartbeatAt: now(),
                discordReady: !stopped && !client.dealBotStopping && client.isReady(),
                stopping: stopped || Boolean(client.dealBotStopping) };
            if (!status.stopping && getMetrics) {
                try { status.transcriptQueue = queueMetrics(getMetrics()); }
                catch (error) { logger.warn('[HEALTH] Queue metrics are temporarily unavailable:', error.code ?? error.name); }
            }
            temporary = `${filename}.${randomUUID()}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify(status), { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporary, filename);
        } catch (error) {
            logger.warn('[HEALTH] Could not update the runtime heartbeat:', error.code ?? error.name);
        } finally {
            if (temporary) {
                try { fs.unlinkSync(temporary); }
                catch (error) { if (error.code !== 'ENOENT') logger.warn('[HEALTH] Could not remove an incomplete heartbeat:', error.code ?? error.name); }
            }
        }
    }
    write();
    const timer = schedule(() => { if (!stopped) write(); }, intervalMs);
    timer.unref?.();
    return () => {
        if (stopped) return;
        stopped = true;
        cancel(timer);
        write();
    };
}

module.exports = { HEALTH_INTERVAL_MS, HEALTH_MAX_AGE_MS, healthStatusPath, inspectHealth, queueMetrics, startRuntimeHealth };
