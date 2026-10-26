const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { backupDatabase } = require('../scripts/backup-database');
const { backupIntervalMs, startBackupMaintenance } = require('../src/services/backupMaintenance');

const root = path.join(__dirname, '..');
const directories = [];
const flush = () => new Promise(resolve => setImmediate(resolve));

function workspace() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-auto-backup-test-'));
    directories.push(directory);
    return directory;
}
function scheduler() {
    const callbacks = [];
    const calls = { cancelled: [], unref: 0, intervals: [] };
    const timer = { unref() { calls.unref++; } };
    return {
        callbacks, calls, timer,
        schedule(fn, intervalMs) { callbacks.push(fn); calls.intervals.push(intervalMs); return timer; },
        cancel(value) { calls.cancelled.push(value); },
    };
}
function logger() {
    const logs = [];
    const warnings = [];
    return { logs, warnings, log: (...values) => logs.push(values), warn: (...values) => warnings.push(values) };
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('automatic backup hours are disabled by default and accept only whole hours within the seven-day bound', () => {
    assert.equal(backupIntervalMs({}), 0);
    assert.equal(backupIntervalMs({ BACKUP_INTERVAL_HOURS: '0' }), 0);
    assert.equal(backupIntervalMs({ BACKUP_INTERVAL_HOURS: ' 1 ' }), 60 * 60 * 1000);
    assert.equal(backupIntervalMs({ BACKUP_INTERVAL_HOURS: '168' }), 168 * 60 * 60 * 1000);
    for (const raw of ['', ' ', '-1', '0.5', '1e2', '01', '169', '1000', 'Infinity', 'NaN', '1garbage']) {
        assert.throws(() => backupIntervalMs({ BACKUP_INTERVAL_HOURS: raw }), /BACKUP_INTERVAL_HOURS/, raw);
    }
});

test('disabled automatic backups create no timer, backup call, or invented SQLite database', async () => {
    const directory = workspace();
    const sourcePath = path.join(directory, 'must-not-exist.sqlite');
    const timers = scheduler();
    let called = 0;
    const stop = startBackupMaintenance({ sourcePath, intervalMs: 0, ...timers,
        backup: async () => { called++; assert.fail('A disabled job cannot open SQLite'); } });
    await flush();
    await stop();
    await stop();
    assert.equal(called, 0);
    assert.equal(timers.callbacks.length, 0);
    assert.equal(timers.calls.cancelled.length, 0);
    assert.equal(fs.existsSync(sourcePath), false);
});

test('importing backup maintenance does not start a timer or initialize an ambient database', () => {
    const directory = workspace();
    const sourcePath = path.join(directory, 'ambient.sqlite');
    const result = spawnSync(process.execPath, ['-e', `
        global.setInterval = () => { throw new Error('Unexpected import timer'); };
        require('./src/services/backupMaintenance');
        console.log(require('node:fs').existsSync(process.env.DATABASE_PATH));
    `], { cwd: root, env: { ...process.env, DATABASE_PATH: sourcePath, BACKUP_INTERVAL_HOURS: '1' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'false');
    assert.equal(fs.existsSync(sourcePath), false);
});

test('enabled backups require a persistent file and a bounded integer interval before scheduling work', () => {
    const timers = scheduler();
    for (const sourcePath of [undefined, '', ' ', ':memory:']) {
        assert.throws(() => startBackupMaintenance({ sourcePath, intervalMs: 1000, ...timers }), /persistent SQLite/);
    }
    for (const intervalMs of [-1, 0.5, NaN, Infinity, 168 * 60 * 60 * 1000 + 1]) {
        assert.throws(() => startBackupMaintenance({ sourcePath: '/tmp/example.sqlite', intervalMs, ...timers }), /interval/);
    }
    assert.equal(timers.callbacks.length, 0);
});

test('startup and periodic backups never overlap, and stopping waits for the in-flight snapshot', async () => {
    const timers = scheduler();
    const records = logger();
    const calls = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const stop = startBackupMaintenance({ sourcePath: '/tmp/live-source.sqlite', intervalMs: 1000,
        ...timers, logger: records,
        backup: async options => {
            calls.push(options);
            await held;
            return { path: '/tmp/snapshot.sqlite', bytes: 1234 };
        } });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(timers.callbacks.length, 1);
    assert.equal(timers.calls.unref, 1);
    assert.deepEqual(timers.calls.intervals, [1000]);
    const competing = [timers.callbacks[0](), timers.callbacks[0]()];
    await flush();
    assert.equal(calls.length, 1);
    let stopped = false;
    const shuttingDown = stop().then(() => { stopped = true; });
    await flush();
    assert.equal(stopped, false);
    assert.deepEqual(timers.calls.cancelled, [timers.timer]);
    release();
    await Promise.all([...competing, shuttingDown]);
    assert.equal(stopped, true);
    await stop();
    await timers.callbacks[0]();
    assert.equal(calls.length, 1);
    assert.equal(records.logs.length, 1);
    assert.equal(timers.calls.cancelled.length, 1);
});

test('a failed snapshot logs only its error code and a later timer run can recover', async () => {
    const timers = scheduler();
    const records = logger();
    const secret = 'PRIVATE_DATABASE_RECORD_SHOULD_NOT_APPEAR';
    let attempts = 0;
    const stop = startBackupMaintenance({ sourcePath: '/tmp/live-source.sqlite', intervalMs: 1000,
        ...timers, logger: records,
        backup: async () => {
            attempts++;
            if (attempts === 1) throw Object.assign(new Error(secret), { code: 'SQLITE_BUSY' });
            return { path: '/tmp/recovered.sqlite', bytes: 8192 };
        } });
    await flush();
    assert.equal(records.warnings.length, 1);
    assert.match(JSON.stringify(records.warnings), /SQLITE_BUSY/);
    assert.doesNotMatch(JSON.stringify(records.warnings), new RegExp(secret));
    await timers.callbacks[0]();
    assert.equal(attempts, 2);
    assert.equal(records.logs.length, 1);
    assert.equal(records.warnings.length, 1);
    await stop();
});

test('a configured backup directory receives unique timestamped names rather than overwriting earlier snapshots', async () => {
    const timers = scheduler();
    const records = logger();
    const directory = path.join(workspace(), 'private snapshots');
    const calls = [];
    const stop = startBackupMaintenance({ sourcePath: '/tmp/live-source.sqlite', intervalMs: 1000,
        directory, now: () => new Date('2026-10-26T12:00:00.000Z'), ...timers, logger: records,
        backup: async options => { calls.push(options); return { path: options.outputPath, bytes: 4096 }; } });
    await flush();
    await timers.callbacks[0]();
    await stop();
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].outputPath, calls[1].outputPath);
    for (const call of calls) {
        assert.equal(call.sourcePath, '/tmp/live-source.sqlite');
        assert.equal(path.dirname(call.outputPath), directory);
        assert.match(path.basename(call.outputPath), /^escrow-2026-10-26T12-00-00-000Z-[a-f0-9]{8}\.sqlite$/);
    }
});

test('the startup job publishes a real verified online snapshot containing committed WAL rows', async () => {
    const directory = workspace();
    const sourcePath = path.join(directory, 'live.sqlite');
    const destination = path.join(directory, 'snapshots');
    const database = new Database(sourcePath);
    const timers = scheduler();
    const records = logger();
    let stop;
    try {
        database.pragma('journal_mode = WAL');
        database.pragma('wal_autocheckpoint = 0');
        database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, description TEXT NOT NULL)');
        database.prepare('INSERT INTO records (description) VALUES (?)').run('PRIVATE_WAL_RECORD');
        let finish;
        const finished = new Promise(resolve => { finish = resolve; });
        stop = startBackupMaintenance({ sourcePath, intervalMs: 1000, directory: destination,
            ...timers, logger: records,
            backup: async options => {
                const result = await backupDatabase(options);
                finish(result);
                return result;
            } });
        const result = await finished;
        await stop();
        const copy = new Database(result.path, { readonly: true, fileMustExist: true });
        try {
            assert.equal(copy.prepare('SELECT COUNT(*) AS total FROM records').get().total, 1);
            assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
            assert.deepEqual(copy.pragma('foreign_key_check'), []);
        } finally { copy.close(); }
        assert.equal(fs.readdirSync(destination).length, 1);
        assert.doesNotMatch(JSON.stringify(records.logs), /PRIVATE_WAL_RECORD/);
        if (process.platform !== 'win32') assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
    } finally {
        if (stop) await stop();
        database.close();
    }
});
