const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HEALTH_MAX_AGE_MS, healthStatusPath, inspectHealth, startRuntimeHealth } = require('../src/services/runtimeHealth');
const { checkHealth } = require('../scripts/healthcheck');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'scripts/healthcheck.js');
const directories = [];
function workspace() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-health-test-'));
    directories.push(directory);
    return directory;
}
function status(overrides = {}) {
    return { version: 1, pid: process.pid, startedAt: 100000, heartbeatAt: 120000,
        discordReady: true, stopping: false, ...overrides };
}
function scheduler() {
    const calls = { unref: 0, cancel: [], interval: null, callback: null };
    const timer = { unref: () => { calls.unref++; } };
    return { calls, schedule: (callback, interval) => {
        calls.callback = callback;
        calls.interval = interval;
        return timer;
    }, cancel: candidate => { assert.equal(candidate, timer); calls.cancel.push(candidate); } };
}

test('operator health exposes only aggregate queue counts and metrics failures do not hide the heartbeat', () => {
    const filename = path.join(workspace(), 'health.json');
    const timing = scheduler();
    let fail = false;
    const stop = startRuntimeHealth({ client: { isReady: () => true }, statusPath: filename,
        now: () => 120000, schedule: timing.schedule, cancel: timing.cancel,
        getMetrics: () => {
            if (fail) throw Object.assign(new Error('PRIVATE_RECORD_MUST_NOT_LEAK'), { code: 'SQLITE_BUSY' });
            return { pendingRecipients: 2, failedRecipients: 1, pendingArchives: 0, unavailableArchives: 3,
                privateToken: 'DO_NOT_EXPOSE', recipientId: 'PRIVATE_USER_ID' };
        }, logger: { warn() {} } });
    try {
        const output = checkHealth({ filename, now: 120000, isAlive: () => true });
        assert.equal(output.healthy, true);
        assert.deepEqual(output.transcriptQueue, { pendingRecipients: 2, failedRecipients: 1, pendingArchives: 0, unavailableArchives: 3 });
        assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /DO_NOT_EXPOSE|PRIVATE_USER_ID/);
        fail = true;
        timing.calls.callback();
        assert.equal(checkHealth({ filename, now: 120000, isAlive: () => true }).healthy, true);
    } finally { stop(); }
});
afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('a fresh ready heartbeat requires a live process and accepts only the documented age boundary', () => {
    let checkedPid;
    const alive = pid => { checkedPid = pid; return true; };
    assert.equal(inspectHealth(status(), { now: 120000, isAlive: alive }).healthy, true);
    assert.equal(checkedPid, process.pid);
    assert.equal(inspectHealth(status(), { now: 120000 + HEALTH_MAX_AGE_MS, isAlive: alive }).healthy, true);
    assert.equal(inspectHealth(status(), { now: 120001 + HEALTH_MAX_AGE_MS, isAlive: alive }).healthy, false);
    assert.equal(inspectHealth(status({ heartbeatAt: 125000 }), { now: 120000, isAlive: alive }).healthy, true);
});

test('stale, dead, offline, stopping, and future-clock heartbeats cannot report a healthy bot', () => {
    const live = { now: 120000, isAlive: () => true };
    for (const value of [
        status({ heartbeatAt: 125001 }), status({ startedAt: 120001 }),
        status({ discordReady: false }), status({ discordReady: 'true' }), status({ stopping: true }),
    ]) assert.equal(inspectHealth(value, live).healthy, false, JSON.stringify(value));
    assert.match(inspectHealth(status(), { ...live, isAlive: () => false }).reason, /not running/i);
    assert.equal(inspectHealth(status({ pid: 2147483647 }), { now: 120000 }).healthy, false);
});

test('malformed heartbeat data including negative timestamps is rejected before checking a PID', () => {
    for (const value of [null, [], {}, status({ version: 2 }), status({ pid: 0 }), status({ pid: 1.5 }),
        status({ heartbeatAt: NaN }), status({ heartbeatAt: '120000' }), status({ startedAt: -1 }),
        status({ startedAt: -2, heartbeatAt: -1 })]) {
        let checked = false;
        const clock = Math.max(0, Number.isSafeInteger(value?.heartbeatAt) ? value.heartbeatAt : 120000);
        const result = inspectHealth(value, { now: clock, isAlive: () => { checked = true; return true; } });
        assert.equal(result.healthy, false, JSON.stringify(value));
        assert.match(result.reason, /invalid/i);
        assert.equal(checked, false, 'An invalid heartbeat must not be used to probe a process');
    }
});

test('file health checks reject missing, corrupt, directory, and oversized heartbeat files without creating state', () => {
    const directory = workspace();
    const missing = path.join(directory, 'missing.json');
    assert.equal(checkHealth({ filename: missing }).healthy, false);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(checkHealth({ filename: directory }).healthy, false);
    const corrupt = path.join(directory, 'corrupt.json');
    fs.writeFileSync(corrupt, '{ broken JSON');
    assert.equal(checkHealth({ filename: corrupt }).healthy, false);
    const large = path.join(directory, 'large.json');
    fs.writeFileSync(large, JSON.stringify(status()) + ' '.repeat(17000));
    assert.match(checkHealth({ filename: large }).reason, /file is invalid/i);
    const valid = path.join(directory, 'valid.json');
    fs.writeFileSync(valid, JSON.stringify(status()));
    assert.equal(checkHealth({ filename: valid, now: 120000, isAlive: () => true }).healthy, true);
});

test('heartbeat replacement publishes a complete private file atomically without exposing a partial destination', () => {
    const directory = workspace();
    const filename = path.join(directory, 'health.json');
    const previous = JSON.stringify(status({ heartbeatAt: 110000 }));
    fs.writeFileSync(filename, previous);
    const timing = scheduler();
    const originalRename = fs.renameSync;
    let replacements = 0;
    fs.renameSync = (source, destination) => {
        if (destination === filename) {
            replacements++;
            if (replacements === 1) assert.equal(fs.readFileSync(filename, 'utf8'), previous);
            const temporary = JSON.parse(fs.readFileSync(source, 'utf8'));
            assert.equal(temporary.pid, process.pid);
            assert.equal(temporary.version, 1);
            if (process.platform !== 'win32') assert.equal(fs.statSync(source).mode & 0o777, 0o600);
        }
        return originalRename(source, destination);
    };
    let stop;
    try {
        stop = startRuntimeHealth({ client: { isReady: () => true }, statusPath: filename,
            now: () => 120000, schedule: timing.schedule, cancel: timing.cancel });
        assert.equal(replacements, 1);
        assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).discordReady, true);
        assert.deepEqual(fs.readdirSync(directory), ['health.json']);
        if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    } finally {
        fs.renameSync = originalRename;
        stop?.();
    }
});

test('heartbeat scheduling tracks readiness and stopping, unreferences its timer, and stops idempotently', () => {
    const filename = path.join(workspace(), 'private', 'health.json');
    const timing = scheduler();
    let clock = 120000;
    let ready = false;
    const client = { isReady: () => ready };
    const stop = startRuntimeHealth({ client, statusPath: filename, intervalMs: 1000,
        now: () => clock, schedule: timing.schedule, cancel: timing.cancel });
    try {
        const read = () => JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
        assert.equal(timing.calls.interval, 1000);
        assert.equal(timing.calls.unref, 1);
        assert.equal(read().discordReady, false);
        ready = true;
        clock += 1000;
        timing.calls.callback();
        assert.equal(read().discordReady, true);
        assert.equal(read().startedAt, 120000);
        assert.equal(read().heartbeatAt, 121000);
        client.dealBotStopping = true;
        clock += 1000;
        timing.calls.callback();
        assert.equal(read().discordReady, false);
        assert.equal(read().stopping, true);
        client.dealBotStopping = false;
        stop();
        assert.equal(timing.calls.cancel.length, 1);
        assert.equal(read().stopping, true);
        assert.equal(read().discordReady, false);
        const terminal = fs.readFileSync(filename, 'utf8');
        clock += 1000;
        timing.calls.callback();
        stop();
        assert.equal(timing.calls.cancel.length, 1);
        assert.equal(fs.readFileSync(filename, 'utf8'), terminal);
        assert.equal(inspectHealth(read(), { now: clock, isAlive: () => true }).healthy, false);
    } finally { stop(); }
});

test('failed atomic publication preserves the prior heartbeat and removes the incomplete file', () => {
    const directory = workspace();
    const filename = path.join(directory, 'health.json');
    const previous = JSON.stringify(status({ discordReady: false }));
    fs.writeFileSync(filename, previous);
    const timing = scheduler();
    const warnings = [];
    const originalRename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('PRIVATE_PATH_MARKER_MUST_NOT_BE_LOGGED'), { code: 'EACCES' }); };
    let stop;
    try {
        stop = startRuntimeHealth({ client: { isReady: () => true }, statusPath: filename,
            now: () => 120000, schedule: timing.schedule, cancel: timing.cancel,
            logger: { warn: (...args) => warnings.push(args) } });
        assert.equal(fs.readFileSync(filename, 'utf8'), previous);
        assert.deepEqual(fs.readdirSync(directory), ['health.json']);
        timing.calls.callback();
        assert.equal(warnings.length, 2);
        assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_PATH_MARKER/);
        assert.match(JSON.stringify(warnings), /EACCES/);
    } finally {
        fs.renameSync = originalRename;
        stop?.();
    }
});

test('runtime health rejects invalid start settings before scheduling work', () => {
    const timing = scheduler();
    for (const values of [{}, { client: {} }, { client: { isReady: () => true }, intervalMs: 0 },
        { client: { isReady: () => true }, intervalMs: 1.5 }, { client: { isReady: () => true }, statusPath: ' ' }]) {
        assert.throws(() => startRuntimeHealth({ schedule: timing.schedule, ...values }), /client|required|positive|heartbeat/i);
    }
    assert.equal(timing.calls.callback, null);
});

test('health paths respect explicit overrides and persistent database folders without using credentials', () => {
    const values = Object.freeze({ DATABASE_PATH: 'private/db.sqlite', DISCORD_TOKEN: 'PRIVATE_CREDENTIAL_MARKER' });
    assert.equal(healthStatusPath(values), path.join(path.resolve('private'), 'health.json'));
    assert.equal(healthStatusPath({ DATABASE_PATH: ':memory:' }), path.join(root, 'data', 'health.json'));
    assert.equal(healthStatusPath({}), path.join(root, 'data', 'health.json'));
    assert.equal(healthStatusPath({ ...values, HEALTH_STATUS_PATH: ' override/status.json ' }), path.resolve('override/status.json'));
    assert.doesNotMatch(healthStatusPath(values), /PRIVATE_CREDENTIAL_MARKER/);
    assert.equal(values.DATABASE_PATH, 'private/db.sqlite');
});

test('importing runtime health and its CLI creates no files, timers, or Discord session', () => {
    const result = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        for (const name of ['writeFileSync', 'mkdirSync', 'renameSync']) fs[name] = () => { throw new Error('Unexpected filesystem mutation'); };
        global.setInterval = () => { throw new Error('Unexpected timer'); };
        require('./src/services/runtimeHealth');
        require('./scripts/healthcheck');
        process.stdout.write('imported');
    `], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'imported');
});

test('the standalone health CLI distinguishes a live ready process from a dead process without logging credentials', () => {
    const directory = workspace();
    const filename = path.join(directory, 'health.json');
    const originalHealthPath = process.env.HEALTH_STATUS_PATH;
    const heartbeat = status({ startedAt: Date.now() - 1000, heartbeatAt: Date.now() });
    fs.writeFileSync(filename, JSON.stringify(heartbeat));
    const environment = { ...process.env, HEALTH_STATUS_PATH: filename, DISCORD_TOKEN: 'PRIVATE_CREDENTIAL_MARKER' };
    const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: environment, encoding: 'utf8' });
    const healthy = run([]);
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.match(healthy.stdout, /fresh heartbeat/i);
    assert.doesNotMatch(healthy.stdout + healthy.stderr, /PRIVATE_CREDENTIAL_MARKER/);
    fs.writeFileSync(filename, JSON.stringify({ ...heartbeat, pid: 2147483647 }));
    const dead = run([]);
    assert.equal(dead.status, 1);
    assert.match(dead.stdout, /not running/i);
    const help = run(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Does not log in or contact Discord/);
    assert.notEqual(run(['--unknown']).status, 0);
    assert.equal(process.env.HEALTH_STATUS_PATH, originalHealthPath);
});
