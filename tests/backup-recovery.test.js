const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { verifyBackup, parseArguments } = require('../scripts/verify-backup');

const root = path.join(__dirname, '..');
const schemaPath = path.join(root, 'src/database/schema.sql');
const cli = path.join(root, 'scripts/verify-backup.js');
const directories = [];
const privateBuyer = 'PRIVATE_BUYER_LABEL_FOR_RECOVERY_TEST';
const privateItem = 'CONFIDENTIAL_ITEM_FOR_RECOVERY_TEST';

function workspace() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-recovery-test-'));
    directories.push(directory);
    return directory;
}

function digest(filename) {
    return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function sourceDatabase({ directory = workspace(), legacy = false, wal = false } = {}) {
    const sourcePath = path.join(directory, legacy ? 'legacy.sqlite' : 'source.sqlite');
    const database = new Database(sourcePath);
    database.pragma('foreign_keys = ON');
    if (wal) {
        database.pragma('journal_mode = WAL');
        database.pragma('wal_autocheckpoint = 0');
    }
    let schema = fs.readFileSync(schemaPath, 'utf8');
    if (legacy) {
        schema = schema
            .replace(/^.*buyer_close_approved.*\r?\n/gm, '')
            .replace(/^.*seller_close_approved.*\r?\n/gm, '')
            .replace(/^.*payment_unit.*\r?\n/gm, '')
            .replace(/CREATE TABLE IF NOT EXISTS escrow_thread_closures[\s\S]*$/, '')
            .replace(/^.*(?:hub_channel_id|language\s+TEXT|(?:bronze|silver|gold|platinum|diamond)_role_id).*\r?\n/gm, '');
    }
    database.exec(schema);
    const insertUser = database.prepare(`INSERT INTO users
        (discord_id, username, account_created_at, trust_score) VALUES (?, ?, '2020-01-01', ?)`);
    insertUser.run('recovery-buyer', privateBuyer, 37);
    insertUser.run('recovery-seller', 'Private Seller', 0);
    database.prepare('INSERT INTO guild_settings (guild_id, moderator_role_id) VALUES (?, ?)')
        .run('recovery-guild', 'recovery-staff');
    database.prepare(`INSERT INTO escrow_transactions
        (transaction_uuid, guild_id, buyer_id, seller_id, item_description, amount, currency)
        VALUES ('ESC-RECOVERY', 'recovery-guild', 1, 2, ?, 22, 'USD')`).run(privateItem);
    database.prepare(`INSERT INTO escrow_events (escrow_id, event_type, to_status)
        VALUES (1, 'created', 'pending')`).run();
    return { sourcePath, database, directory };
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('recovery verification opens a usable migrated copy while leaving the original database unchanged', async () => {
    const f = sourceDatabase();
    f.database.close();
    const original = digest(f.sourcePath);
    const originalNames = fs.readdirSync(f.directory).sort();
    const previousDatabasePath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = 'RECOVERY_ENV_MARKER_ONLY';
    try {
        const result = await verifyBackup({ sourcePath: f.sourcePath });
        assert.equal(result.verified, true);
        assert.equal(result.migrated, true);
        assert.deepEqual(result.counts, { users: 2, deals: 1, events: 1, guilds: 1 });
        assert.ok(result.schemaTables >= 15);
        assert.equal(process.env.DATABASE_PATH, 'RECOVERY_ENV_MARKER_ONLY');
        assert.equal(digest(f.sourcePath), original);
        assert.deepEqual(fs.readdirSync(f.directory).sort(), originalNames);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(`${privateBuyer}|${privateItem}|RECOVERY_ENV_MARKER_ONLY`));
    } finally {
        if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previousDatabasePath;
    }
});

test('a legacy backup can migrate in isolation without adding columns or changing global scores in the source', async () => {
    const f = sourceDatabase({ legacy: true });
    const beforeTables = f.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count;
    const beforeColumns = f.database.pragma('table_info(escrow_transactions)').map(column => column.name);
    f.database.close();
    const original = digest(f.sourcePath);
    const result = await verifyBackup({ sourcePath: f.sourcePath });
    assert.equal(result.verified, true);
    assert.equal(result.migrated, true);
    assert.equal(result.counts.deals, 1);
    assert.ok(result.schemaTables > beforeTables, 'The isolated copy should contain the current migrated schema');
    assert.equal(digest(f.sourcePath), original);
    const source = new Database(f.sourcePath, { readonly: true, fileMustExist: true });
    try {
        assert.deepEqual(source.pragma('table_info(escrow_transactions)').map(column => column.name), beforeColumns);
        assert.equal(source.prepare('SELECT trust_score FROM users WHERE id=1').get().trust_score, 37);
        assert.equal(source.prepare('SELECT item_description FROM escrow_transactions WHERE id=1').get().item_description, privateItem);
    } finally { source.close(); }
});

test('committed WAL data participates in the recovery rehearsal without altering source database or WAL bytes', async () => {
    const f = sourceDatabase({ wal: true });
    try {
        f.database.prepare(`INSERT INTO users (discord_id, username, account_created_at)
            VALUES ('wal-only-user', 'Committed only in WAL', '2020-01-01')`).run();
        const walPath = `${f.sourcePath}-wal`;
        assert.ok(fs.statSync(walPath).size > 0);
        const beforeDatabase = digest(f.sourcePath);
        const beforeWal = digest(walPath);
        const result = await verifyBackup({ sourcePath: f.sourcePath });
        assert.equal(result.counts.users, 3);
        assert.equal(result.counts.deals, 1);
        assert.equal(digest(f.sourcePath), beforeDatabase);
        assert.equal(digest(walPath), beforeWal);
        assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 3);
    } finally { f.database.close(); }
});

test('missing, memory, directory, and malformed paths never create a source database', async () => {
    const directory = workspace();
    const missing = path.join(directory, 'missing.sqlite');
    for (const sourcePath of [missing, ':memory:', '', null, 23, directory]) {
        await assert.rejects(verifyBackup({ sourcePath }));
    }
    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('non-SQLite and unrelated SQLite files cannot be approved as bot backups', async () => {
    const directory = workspace();
    const invalid = path.join(directory, 'invalid.sqlite');
    fs.writeFileSync(invalid, 'Do not replace or repair this file.');
    const invalidBytes = digest(invalid);
    await assert.rejects(verifyBackup({ sourcePath: invalid }));
    assert.equal(digest(invalid), invalidBytes);
    const unrelated = path.join(directory, 'unrelated.sqlite');
    const database = new Database(unrelated);
    database.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, private_label TEXT);');
    database.close();
    const original = digest(unrelated);
    await assert.rejects(verifyBackup({ sourcePath: unrelated }), /DealBot|bot|schema|table/i);
    assert.equal(digest(unrelated), original);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['invalid.sqlite', 'unrelated.sqlite']);
});

test('foreign key violations fail verification without repairing the original database', async () => {
    const f = sourceDatabase();
    f.database.pragma('foreign_keys = OFF');
    f.database.prepare(`INSERT INTO escrow_transactions
        (transaction_uuid, guild_id, buyer_id, seller_id, item_description, amount, currency)
        VALUES ('ESC-INVALID-FOREIGN-KEY', 'recovery-guild', 999, 2, 'Broken reference', 1, 'USD')`).run();
    f.database.close();
    const original = digest(f.sourcePath);
    await assert.rejects(verifyBackup({ sourcePath: f.sourcePath }), /foreign key/i);
    assert.equal(digest(f.sourcePath), original);
});

test('core table names without valid application columns are rejected instead of silently recreated', async () => {
    const directory = workspace();
    const sourcePath = path.join(directory, 'wrong-shape.sqlite');
    const database = new Database(sourcePath);
    database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE escrow_transactions (id INTEGER PRIMARY KEY);
        CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY);`);
    database.close();
    const original = digest(sourcePath);
    await assert.rejects(verifyBackup({ sourcePath }), /schema|column|migrat|compatible|DealBot/i);
    assert.equal(digest(sourcePath), original);
});

test('a failed isolated migration hides private trigger text and cleans its disposable restored copy', async () => {
    const f = sourceDatabase();
    const marker = 'PRIVATE_TRIGGER_TEXT_MUST_NOT_REACH_OPERATOR_LOGS';
    f.database.prepare("UPDATE guild_settings SET language = 'ar'").run();
    f.database.exec(`CREATE TRIGGER fail_recovery_language BEFORE UPDATE OF language ON guild_settings
        WHEN NEW.language = 'en' BEGIN SELECT RAISE(ABORT, '${marker}'); END;`);
    f.database.close();
    const original = digest(f.sourcePath);
    const temporaryNames = ['TMPDIR', 'TMP', 'TEMP'];
    const originalEnvironment = Object.fromEntries(temporaryNames.map(name => [name, process.env[name]]));
    for (const name of temporaryNames) process.env[name] = f.directory;
    try {
        await assert.rejects(verifyBackup({ sourcePath: f.sourcePath }), error => {
            assert.equal(error.code, 'RECOVERY_MIGRATION_FAILED');
            assert.match(error.message, /isolated.*migrations/i);
            assert.doesNotMatch(error.message, new RegExp(marker));
            return true;
        });
        assert.equal(digest(f.sourcePath), original);
        assert.deepEqual(fs.readdirSync(f.directory), ['source.sqlite']);
        const result = spawnSync(process.execPath, [cli, f.sourcePath], {
            cwd: root, env: { ...process.env }, encoding: 'utf8',
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /isolated.*migrations/i);
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${marker}|${privateBuyer}|${privateItem}`));
        assert.equal(digest(f.sourcePath), original);
        assert.deepEqual(fs.readdirSync(f.directory), ['source.sqlite']);
    } finally {
        for (const name of temporaryNames) {
            if (originalEnvironment[name] === undefined) delete process.env[name];
            else process.env[name] = originalEnvironment[name];
        }
    }
});

test('CLI parsing accepts exactly one source filename or help, with no ambient default', () => {
    assert.deepEqual(parseArguments(['source.sqlite']), { sourcePath: 'source.sqlite' });
    assert.deepEqual(parseArguments(['/tmp/source with spaces.sqlite']), { sourcePath: '/tmp/source with spaces.sqlite' });
    assert.deepEqual(parseArguments(['--help']), { help: true });
    assert.deepEqual(parseArguments(['-h']), { help: true });
    for (const args of [[], [''], [':memory:'], ['--unknown'], ['one.sqlite', 'two.sqlite'], ['--help', 'source.sqlite'], ['source.sqlite', '--help']]) {
        assert.throws(() => parseArguments(args));
    }
});

test('CLI reports only recovery status and counts without records, credentials, or touching an ambient database path', () => {
    const f = sourceDatabase();
    f.database.close();
    const ambient = path.join(f.directory, 'must-not-exist.sqlite');
    const result = spawnSync(process.execPath, [cli, f.sourcePath], {
        cwd: root, env: { ...process.env, DATABASE_PATH: ambient, DISCORD_TOKEN: 'RECOVERY_ENV_MARKER_ONLY' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[RECOVERY\]/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${privateBuyer}|${privateItem}|RECOVERY_ENV_MARKER_ONLY`));
    const report = JSON.parse(result.stdout.trim().replace(/^\[RECOVERY\]\s*/, ''));
    assert.equal(report.verified, true);
    assert.equal(report.counts.users, 2);
    assert.equal(fs.existsSync(ambient), false);
    const help = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /copy|rehears|isolat/i);
    const missing = spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
});
