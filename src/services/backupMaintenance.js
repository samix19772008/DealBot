const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { backupDatabase } = require('../../scripts/backup-database');

function backupIntervalMs(values = process.env) {
    const raw = String(values.BACKUP_INTERVAL_HOURS ?? '0').trim();
    if (!/^(?:0|[1-9]\d{0,2})$/.test(raw) || Number(raw) > 168) {
        throw new Error('BACKUP_INTERVAL_HOURS must be 0 to disable scheduling, or a whole number from 1 to 168.');
    }
    return Number(raw) * 60 * 60 * 1000;
}

/** A configured live bot takes one verified startup snapshot, then periodic snapshots. */
function startBackupMaintenance({ sourcePath, intervalMs = backupIntervalMs(), directory = process.env.BACKUP_DIRECTORY,
    backup = backupDatabase, schedule = setInterval, cancel = clearInterval, now = () => new Date(), logger = console } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 168 * 60 * 60 * 1000) {
        throw new Error('The automatic-backup interval must be a nonnegative integer no longer than seven days.');
    }
    let stopped = false;
    let active;
    let timer;
    async function run() {
        if (stopped || !intervalMs || active) return active;
        active = Promise.resolve().then(async () => {
            try {
                const options = { sourcePath };
                if (directory?.trim()) {
                    options.outputPath = path.join(path.resolve(directory.trim()),
                        `escrow-${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`);
                }
                const result = await backup(options);
                logger.log('[BACKUP] Automatic verified snapshot:', result.path, `(${result.bytes} bytes)`);
            } catch (error) {
                logger.warn('[BACKUP] Automatic snapshot failed:', error.code ?? error.name);
            }
        }).finally(() => { active = null; });
        return active;
    }
    if (intervalMs) {
        if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath === ':memory:') {
            throw new Error('Automatic backups require a persistent SQLite database file.');
        }
        run();
        timer = schedule(run, intervalMs);
        timer.unref?.();
    }
    return async () => {
        if (!stopped) {
            stopped = true;
            if (timer) cancel(timer);
        }
        if (active) await active;
    };
}

module.exports = { backupIntervalMs, startBackupMaintenance };
