process.env.DATABASE_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startTranscriptMaintenance } = require('../src/services/transcriptMaintenance');

const flush = () => new Promise(resolve => setImmediate(resolve));

test('importing transcript maintenance does not create a background timer or log in', () => {
    const result = spawnSync(process.execPath, ['-e', `
        const client = require('./src/client');
        client.login = () => { throw new Error('Unexpected login'); };
        global.setInterval = () => { throw new Error('Unexpected import-time timer'); };
        require('./src/services/transcriptMaintenance');
        client.destroy();
        require('./src/database/init').db.close();
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: ':memory:' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});

test('transcript maintenance starts explicitly, avoids overlapping runs, and unrefs its timer', async () => {
    let tick;
    let runs = 0;
    let unrefs = 0;
    let cancelled = 0;
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const timer = { unref: () => { unrefs++; } };
    const client = { id: 'test-client' };
    const stop = startTranscriptMaintenance({
        client, intervalMs: 1000, stopWorker: async () => {},
        processQueue: async supplied => { assert.equal(supplied, client); runs++; if (runs === 1) await blocked; },
        schedule: (callback, delay) => { tick = callback; assert.equal(delay, 1000); return timer; },
        cancel: supplied => { assert.equal(supplied, timer); cancelled++; },
        onError: error => assert.fail(error.message),
    });
    await flush();
    assert.equal(runs, 1);
    assert.equal(unrefs, 1);
    tick();
    tick();
    await flush();
    assert.equal(runs, 1);
    release();
    await flush();
    tick();
    await flush();
    assert.equal(runs, 2);
    await stop();
    await stop();
    assert.equal(cancelled, 1);
    tick();
    await flush();
    assert.equal(runs, 2);
});

test('stopping maintenance waits for the active queue operation before resolving', async () => {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let settled = false;
    const stop = startTranscriptMaintenance({
        client: {}, processQueue: async () => blocked, stopWorker: async () => {},
        schedule: () => ({ unref() {} }), cancel: () => {}, onError: error => assert.fail(error.message),
    });
    await flush();
    const stopping = stop().then(() => { settled = true; });
    await flush();
    assert.equal(settled, false);
    release();
    await stopping;
    assert.equal(settled, true);
});

test('a failed queue pass is reported and later scheduled passes can still retry', async () => {
    const errors = [];
    let tick;
    let attempts = 0;
    const stop = startTranscriptMaintenance({
        client: {}, processQueue: async () => { if (++attempts === 1) throw new Error('Temporary SQLite issue'); },
        stopWorker: async () => {},
        schedule: callback => { tick = callback; return { unref() {} }; }, cancel: () => {},
        onError: error => { errors.push(error.message); },
    });
    await flush();
    assert.deepEqual(errors, ['Temporary SQLite issue']);
    tick();
    await flush();
    assert.equal(attempts, 2);
    await stop();
});

test('concurrent stop calls both wait for the event-triggered delivery worker to drain', async () => {
    let releaseWorker;
    const drainingWorker = new Promise(resolve => { releaseWorker = resolve; });
    let stopWorkerCalls = 0;
    const stop = startTranscriptMaintenance({ client: {}, processQueue: async () => {},
        stopWorker: async () => { stopWorkerCalls++; await drainingWorker; },
        schedule: () => ({ unref() {} }), cancel: () => {}, onError: error => assert.fail(error.message) });
    await flush();
    let firstFinished = false;
    let secondFinished = false;
    const first = stop().then(() => { firstFinished = true; });
    const second = stop().then(() => { secondFinished = true; });
    await flush();
    assert.equal(firstFinished, false);
    assert.equal(secondFinished, false);
    assert.equal(stopWorkerCalls, 1);
    releaseWorker();
    await Promise.all([first, second]);
    assert.equal(firstFinished, true);
    assert.equal(secondFinished, true);
});

test('invalid maintenance intervals are rejected before creating timers or running jobs', () => {
    for (const intervalMs of [0, -1, NaN, Infinity, 1.5]) {
        assert.throws(() => startTranscriptMaintenance({ client: {}, intervalMs,
            processQueue: async () => assert.fail('Invalid configuration must not run work'),
            schedule: () => assert.fail('Invalid configuration must not schedule') }), /positive.*interval/);
    }
});
