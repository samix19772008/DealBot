const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const { backupDatabase } = require('./backup-database');

const execute = promisify(execFile);
const PROJECT_ROOT = path.join(__dirname, '..');
const REQUIRED_COLUMNS = {
    users: ['id', 'discord_id', 'username', 'account_created_at'],
    escrow_transactions: ['id', 'transaction_uuid', 'guild_id', 'buyer_id', 'seller_id',
        'item_description', 'amount', 'currency', 'status', 'created_at', 'updated_at'],
    guild_settings: ['guild_id', 'moderator_role_id'],
};

// This child opens only the temporary restored copy. It never imports index.js,
// reads .env, logs records, or starts the Discord client or maintenance timers.
const REHEARSAL = `
let database;
try {
    const initialized = require('./src/database/init');
    database = initialized.db;
    initialized.initDatabase();
    if (database.pragma('integrity_check', { simple: true }) !== 'ok' ||
        database.pragma('foreign_key_check').length) throw new Error('Restored integrity failed');
    const count = table => database.prepare('SELECT COUNT(*) AS total FROM ' + table).get().total;
    const counts = { users: count('users'), deals: count('escrow_transactions'),
        events: count('escrow_events'), guilds: count('guild_settings') };
    const deals = require('./src/database/escrowRepository');
    const settings = require('./src/database/guildSettingsRepository');
    require('./src/database/listingRepository');
    require('./src/database/transcriptRepository');
    const firstDeal = database.prepare('SELECT id FROM escrow_transactions ORDER BY id LIMIT 1').get();
    if (firstDeal && !deals.getEscrowById(firstDeal.id)) throw new Error('Restored deal lookup failed');
    const firstGuild = database.prepare('SELECT guild_id FROM guild_settings LIMIT 1').get();
    if (firstGuild && !settings.getGuildSettings(firstGuild.guild_id)) throw new Error('Restored settings lookup failed');
    const schemaTables = database.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().total;
    database.close();
    database = null;
    process.stdout.write(JSON.stringify({ verified: true, migrated: true, counts, schemaTables }));
} catch (error) {
    if (database?.open) database.close();
    process.stderr.write(JSON.stringify({ code: /^SQLITE_[A-Z_]+$/.test(error.code || '') ? error.code : 'RECOVERY_MIGRATION_FAILED' }));
    process.exitCode = 1;
}
`;

function invalid(message, code = 'RECOVERY_INVALID_BACKUP') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function assertDealBotDatabase(snapshotPath) {
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
        for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
            const existing = new Set(snapshot.pragma(`table_info(${table})`).map(column => column.name));
            if (columns.some(column => !existing.has(column))) {
                throw invalid('The file is not a compatible DealBot backup: required tables or columns are missing.');
            }
        }
    } finally { snapshot.close(); }
}

/** Rehearse restoration and current migrations on a disposable copy, never in place. */
async function verifyBackup({ sourcePath } = {}) {
    if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath === ':memory:') {
        throw invalid('Provide the path to an existing DealBot SQLite backup file.');
    }
    let source;
    try {
        source = fs.realpathSync(path.resolve(sourcePath));
        if (!fs.statSync(source).isFile()) throw invalid('The backup source must be an existing SQLite file.');
    } catch (error) {
        if (error.code === 'RECOVERY_INVALID_BACKUP') throw error;
        throw invalid('The backup source could not be opened. Check the file path and read permissions.', error.code || 'RECOVERY_SOURCE_UNAVAILABLE');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-recovery-'));
    fs.chmodSync(directory, 0o700);
    try {
        const restoredPath = path.join(directory, 'restored.sqlite');
        await backupDatabase({ sourcePath: source, outputPath: restoredPath });
        assertDealBotDatabase(restoredPath);
        // Do not inherit tokens, DATABASE_PATH, NODE_OPTIONS, or preload scripts.
        const environment = { DATABASE_PATH: restoredPath };
        for (const name of ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ']) {
            if (process.env[name] !== undefined) environment[name] = process.env[name];
        }
        let output;
        try {
            output = await execute(process.execPath, ['-e', REHEARSAL], {
                cwd: PROJECT_ROOT, env: environment, timeout: 30_000, maxBuffer: 32 * 1024,
                windowsHide: true,
            });
        } catch {
            // Migration errors may contain user-defined trigger text. Keep it out
            // of operator logs; the original backup remains untouched for review.
            throw invalid('The isolated restored copy could not pass current application migrations and repository checks.', 'RECOVERY_MIGRATION_FAILED');
        }
        let result;
        try { result = JSON.parse(output.stdout); }
        catch { throw invalid('The isolated recovery check returned an invalid result.', 'RECOVERY_CHECK_FAILED'); }
        if (result?.verified !== true || result?.migrated !== true ||
            !Number.isSafeInteger(result.schemaTables) || result.schemaTables < Object.keys(REQUIRED_COLUMNS).length ||
            !result.counts || ['users', 'deals', 'events', 'guilds'].some(name =>
                !Number.isSafeInteger(result.counts[name]) || result.counts[name] < 0)) {
            throw invalid('The isolated recovery check returned an invalid result.', 'RECOVERY_CHECK_FAILED');
        }
        return result;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function parseArguments(args) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
    if (args.length !== 1 || typeof args[0] !== 'string' || !args[0].trim() || args[0] === ':memory:' || args[0].startsWith('-')) {
        throw invalid('Usage: node scripts/verify-backup.js /path/to/backup.sqlite');
    }
    return { sourcePath: args[0] };
}

async function runCli(args = process.argv.slice(2)) {
    const options = parseArguments(args);
    if (options.help) {
        console.log('Usage: node scripts/verify-backup.js /path/to/backup.sqlite');
        console.log('Verifies SQLite integrity and rehearses current application migrations on a private temporary copy.');
        console.log('Does not replace a live database, modify the original backup, read .env, or connect to Discord.');
        return;
    }
    const result = await verifyBackup(options);
    console.log(`[RECOVERY] ${JSON.stringify(result)}`);
}

if (require.main === module) runCli().catch(error => {
    const message = error.code?.startsWith('RECOVERY_') || error.message.startsWith('Usage:')
        ? error.message : 'Recovery verification failed; no live database was replaced.';
    console.error(`[RECOVERY] ${message}`);
    process.exitCode = 1;
});

module.exports = { verifyBackup, parseArguments, runCli };
