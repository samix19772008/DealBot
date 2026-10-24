const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { backupDatabase, parseArguments } = require('../scripts/backup-database');

const directories = [];
function workspace() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-backup-test-'));
    directories.push(directory);
    return directory;
}
function sourceDatabase(directory, { wal = false } = {}) {
    const sourcePath = path.join(directory, 'source.sqlite');
    const database = new Database(sourcePath);
    database.pragma('foreign_keys = ON');
    if (wal) {
        database.pragma('journal_mode = WAL');
        database.pragma('wal_autocheckpoint = 0');
    }
    database.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, label TEXT NOT NULL);');
    database.exec('CREATE TABLE deals (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id));');
    database.prepare('INSERT INTO accounts (label) VALUES (?)').run('Original account');
    database.prepare('INSERT INTO deals (account_id) VALUES (?)').run(1);
    return { sourcePath, database };
}
afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('online backup includes committed WAL records and restores without the source WAL/SHM', async () => {
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory, { wal: true });
    try {
        database.prepare('INSERT INTO accounts (label) VALUES (?)').run('Committed in WAL');
        assert.ok(fs.statSync(`${sourcePath}-wal`).size > 0);
        const outputPath = path.join(directory, 'private-backups', 'snapshot.sqlite');
        const result = await backupDatabase({ sourcePath, outputPath });
        assert.equal(result.path, outputPath);
        assert.ok(result.bytes > 0);
        const restored = new Database(outputPath, { readonly: true, fileMustExist: true });
        try {
            assert.deepEqual(restored.prepare('SELECT label FROM accounts ORDER BY id').all(), [
                { label: 'Original account' }, { label: 'Committed in WAL' },
            ]);
            assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
            assert.deepEqual(restored.pragma('foreign_key_check'), []);
            assert.equal(restored.prepare('SELECT COUNT(*) AS total FROM deals').get().total, 1);
        } finally { restored.close(); }
        assert.equal(database.prepare('SELECT COUNT(*) AS total FROM accounts').get().total, 2);
        assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), ['snapshot.sqlite']);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
            assert.equal(fs.statSync(path.dirname(outputPath)).mode & 0o777, 0o700);
        }
    } finally { database.close(); }
});

test('source is preserved exactly and no app migrations or environment values enter the snapshot', async () => {
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory);
    database.close();
    const envFile = path.join(directory, '.env');
    fs.writeFileSync(envFile, 'LOCAL_FIXTURE=not-a-real-credential\n');
    const original = fs.readFileSync(sourcePath);
    const result = await backupDatabase({ sourcePath, outputPath: path.join(directory, 'snapshot.sqlite') });
    assert.deepEqual(fs.readFileSync(sourcePath), original);
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'LOCAL_FIXTURE=not-a-real-credential\n');
    const restored = new Database(result.path, { readonly: true });
    try {
        const tables = restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
        assert.deepEqual(tables, ['accounts', 'deals']);
        assert.equal(fs.readFileSync(result.path).includes(Buffer.from('LOCAL_FIXTURE')), false);
    } finally { restored.close(); }
});

test('missing source is not created and no output parent is created', async () => {
    const directory = workspace();
    const sourcePath = path.join(directory, 'missing.sqlite');
    const outputPath = path.join(directory, 'new-output', 'snapshot.sqlite');
    await assert.rejects(backupDatabase({ sourcePath, outputPath }), { code: 'ENOENT' });
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.existsSync(path.dirname(outputPath)), false);
});

test('an invalid database fails before creating output state', async () => {
    const directory = workspace();
    const sourcePath = path.join(directory, 'invalid.sqlite');
    const original = 'This file is not a SQLite database.';
    fs.writeFileSync(sourcePath, original);
    const outputPath = path.join(directory, 'new-output', 'snapshot.sqlite');
    await assert.rejects(backupDatabase({ sourcePath, outputPath }), /not a database/);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
    assert.equal(fs.existsSync(path.dirname(outputPath)), false);
});

test('the source file and an existing destination are never overwritten', async () => {
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory);
    database.close();
    const original = fs.readFileSync(sourcePath);
    await assert.rejects(backupDatabase({ sourcePath, outputPath: sourcePath }), /must differ/);
    const destination = path.join(directory, 'existing.sqlite');
    fs.writeFileSync(destination, 'Keep this existing backup.');
    await assert.rejects(backupDatabase({ sourcePath, outputPath: destination }), /already exists/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'Keep this existing backup.');
    assert.deepEqual(fs.readFileSync(sourcePath), original);
});

test('existing symlinks, including a source alias and dangling link, are not overwritten', async () => {
    if (process.platform === 'win32') return;
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory);
    database.close();
    const alias = path.join(directory, 'alias.sqlite');
    fs.symlinkSync(sourcePath, alias);
    await assert.rejects(backupDatabase({ sourcePath, outputPath: alias }), /already exists/);
    assert.equal(fs.readlinkSync(alias), sourcePath);
    const dangling = path.join(directory, 'dangling.sqlite');
    fs.symlinkSync(path.join(directory, 'absent.sqlite'), dangling);
    await assert.rejects(backupDatabase({ sourcePath, outputPath: dangling }), /already exists/);
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
});

test('a destination created while SQLite is copying wins without being overwritten', async () => {
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory);
    database.close();
    const outputPath = path.join(directory, 'racing.sqlite');
    const originalBackup = Database.prototype.backup;
    Database.prototype.backup = async function (...args) {
        const result = await originalBackup.apply(this, args);
        fs.writeFileSync(outputPath, 'A different backup owns this destination.');
        return result;
    };
    try {
        await assert.rejects(backupDatabase({ sourcePath, outputPath }), { code: 'EEXIST' });
    } finally {
        Database.prototype.backup = originalBackup;
    }
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'A different backup owns this destination.');
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.dealbot-backup-')), false);
});

test('failed foreign key verification publishes nothing and cleans temporary files', async () => {
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory);
    database.pragma('foreign_keys = OFF');
    database.prepare('INSERT INTO deals (account_id) VALUES (?)').run(999);
    database.close();
    const outputPath = path.join(directory, 'backups', 'invalid.sqlite');
    await assert.rejects(backupDatabase({ sourcePath, outputPath }), /foreign key check failed/);
    assert.equal(fs.existsSync(outputPath), false);
    assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), []);
});

test('default output names are unique private files beside the source database', async () => {
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory);
    database.close();
    const first = await backupDatabase({ sourcePath });
    const second = await backupDatabase({ sourcePath });
    assert.notEqual(first.path, second.path);
    assert.equal(path.dirname(first.path), path.join(directory, 'backups'));
    assert.match(path.basename(first.path), /^escrow-.*\.sqlite$/);
    assert.deepEqual(fs.readdirSync(path.dirname(first.path)).sort(), [path.basename(first.path), path.basename(second.path)].sort());
});

test('CLI uses DATABASE_PATH and emits only the verified destination and size', () => {
    const directory = workspace();
    const { sourcePath, database } = sourceDatabase(directory);
    database.close();
    const outputPath = path.join(directory, 'cli.sqlite');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/backup-database.js'), '--output', outputPath], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: sourcePath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified SQLite backup:/);
    assert.ok(result.stdout.includes(outputPath));
    assert.equal(result.stdout.includes('Original account'), false);
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(outputPath), true);
});

test('CLI returns a failing status for missing database and leaves no invented database', () => {
    const directory = workspace();
    const sourcePath = path.join(directory, 'absent.sqlite');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/backup-database.js')], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: sourcePath },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[BACKUP\]/);
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.existsSync(path.join(directory, 'backups')), false);
});

test('backup rejects in-memory input and CLI rejects ambiguous paths', async () => {
    await assert.rejects(backupDatabase({ sourcePath: ':memory:' }), /existing SQLite database file/);
    assert.deepEqual(parseArguments(['--output', 'new.sqlite']), { outputPath: 'new.sqlite' });
    assert.deepEqual(parseArguments(['-o', 'new.sqlite']), { outputPath: 'new.sqlite' });
    assert.deepEqual(parseArguments(['--help']), { help: true });
    assert.throws(() => parseArguments(['--output']), /requires/);
    assert.throws(() => parseArguments(['--output', 'one', '--output', 'two']), /Usage/);
    assert.throws(() => parseArguments(['unexpected.sqlite']), /Usage/);
});
