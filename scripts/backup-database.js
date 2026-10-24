const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const DEFAULT_DATABASE_PATH = path.join(__dirname, '..', 'data', 'escrow.sqlite');

function existsWithoutFollowingLinks(filePath) {
    try { fs.lstatSync(filePath); return true; }
    catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

/**
 * Use SQLite's online backup API so committed WAL data is part of the snapshot.
 * Opening the existing source read-only deliberately avoids app migrations.
 */
async function backupDatabase({
    sourcePath = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH,
    outputPath,
} = {}) {
    if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath === ':memory:') {
        throw new Error('Backups require the path to an existing SQLite database file.');
    }
    const source = fs.realpathSync(path.resolve(sourcePath));
    if (!fs.statSync(source).isFile()) throw new Error('The source must be an existing SQLite database file.');
    const destination = path.resolve(outputPath || path.join(path.dirname(source), 'backups',
        `escrow-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`));
    if (source === destination) throw new Error('The backup destination must differ from the source database.');
    if (existsWithoutFollowingLinks(destination)) throw new Error('The backup destination already exists; choose a new file name.');

    let database;
    let temporaryDirectory;
    try {
        database = new Database(source, { readonly: true, fileMustExist: true });
        // Validate the source before creating an output directory or file.
        database.pragma('schema_version', { simple: true });
        const parent = path.dirname(destination);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const resolvedDestination = path.join(fs.realpathSync(parent), path.basename(destination));
        if (resolvedDestination === source) throw new Error('The backup destination must differ from the source database.');
        temporaryDirectory = fs.mkdtempSync(path.join(parent, '.dealbot-backup-'));
        const temporaryFile = path.join(temporaryDirectory, 'snapshot.sqlite');
        await database.backup(temporaryFile);
        database.close();
        database = null;

        const verification = new Database(temporaryFile, { fileMustExist: true });
        try {
            // Normalize only the private snapshot to a standalone database file.
            // Otherwise its inherited WAL mode can create sidecars on restoration.
            verification.pragma('journal_mode = DELETE');
            if (verification.pragma('integrity_check', { simple: true }) !== 'ok') {
                throw new Error('The SQLite integrity check failed; no backup was published.');
            }
            if (verification.pragma('foreign_key_check').length) {
                throw new Error('The SQLite foreign key check failed; no backup was published.');
            }
        } finally {
            verification.close();
        }
        fs.chmodSync(temporaryFile, 0o600);
        // A hard link atomically refuses collisions, including a file created
        // after the initial check. A rename could overwrite an existing backup.
        fs.linkSync(temporaryFile, destination);
        return { path: destination, bytes: fs.statSync(destination).size };
    } finally {
        if (database?.open) database.close();
        if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

function parseArguments(args) {
    let outputPath;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === '--help' || argument === '-h') return { help: true };
        if ((argument !== '--output' && argument !== '-o') || outputPath !== undefined) {
            throw new Error('Usage: node scripts/backup-database.js [--output /path/to/new-backup.sqlite]');
        }
        const value = args[++index];
        if (!value || value.startsWith('-')) throw new Error('--output requires a new backup file path.');
        outputPath = value;
    }
    return { outputPath };
}

async function runCli(args = process.argv.slice(2)) {
    const options = parseArguments(args);
    if (options.help) {
        console.log('Usage: node scripts/backup-database.js [--output /path/to/new-backup.sqlite]');
        console.log('Uses DATABASE_PATH or data/escrow.sqlite. Default output: a unique file in the database folder\'s backups/ directory.');
        console.log('Copies committed WAL data using SQLite online backup, verifies integrity and foreign keys, and never overwrites a file.');
        return;
    }
    require('dotenv').config({ quiet: true });
    const result = await backupDatabase(options);
    console.log(`[BACKUP] Verified SQLite backup: ${result.path} (${result.bytes} bytes)`);
}

if (require.main === module) {
    runCli().catch(error => {
        console.error('[BACKUP]', error.message);
        process.exitCode = 1;
    });
}

module.exports = { backupDatabase, parseArguments, runCli, DEFAULT_DATABASE_PATH };
