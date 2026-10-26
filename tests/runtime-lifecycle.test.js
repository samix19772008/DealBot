process.env.DATABASE_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createShutdown } = require('../src/services/runtimeLifecycle');
const { loadEvents, drainClientEvents } = require('../src/handlers/eventHandler');

const quiet = { error() {} };
function pendingWork() {
    let release;
    return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}

test('shutdown rejects new work immediately and drains handlers and workers before SQLite closes', async () => {
    const order = [];
    const client = { destroy: () => order.push('destroy') };
    const handler = pendingWork();
    const worker = pendingWork();
    const stop = createShutdown({ client, stopEarly: [() => order.push('not-ready')],
        drain: async () => { order.push('handlers'); await handler.promise; },
        stopLate: [async () => { order.push('worker'); await worker.promise; }],
        closeDatabase: () => order.push('database'), logger: quiet,
        forceExit: () => assert.fail('Normal shutdown must not force exit') });
    const first = stop();
    assert.equal(client.dealBotStopping, true);
    assert.equal(stop(), first, 'Repeated signals share one shutdown');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['not-ready', 'handlers']);
    handler.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['not-ready', 'handlers', 'worker']);
    worker.release();
    assert.deepEqual(await first, { timedOut: false, failed: false });
    assert.deepEqual(order, ['not-ready', 'handlers', 'worker', 'destroy', 'database']);
});

test('shutdown deadline forces supervised exit without closing SQLite underneath pending work', async () => {
    let deadline;
    const work = pendingWork();
    const calls = [];
    const stop = createShutdown({ client: { destroy: () => calls.push('destroy') }, drain: () => work.promise,
        closeDatabase: () => calls.push('database'), logger: quiet,
        schedule: callback => { deadline = callback; return { unref() {} }; },
        cancel: () => calls.push('cancel'), forceExit: code => calls.push(code) });
    const stopped = stop();
    await new Promise(resolve => setImmediate(resolve));
    deadline();
    assert.deepEqual(calls, [1]);
    work.release();
    assert.deepEqual(await stopped, { timedOut: true, failed: false });
    assert.deepEqual(calls, [1, 'cancel']);
});

test('a worker drain failure uses supervised exit and preserves an open database for unfinished work', async () => {
    const calls = [];
    const stop = createShutdown({ client: { destroy: () => calls.push('destroy') },
        stopLate: [async () => { throw new Error('Still active'); }], closeDatabase: () => calls.push('database'),
        forceExit: code => calls.push(code), logger: quiet });
    assert.deepEqual(await stop(), { timedOut: false, failed: true });
    assert.deepEqual(calls, [1]);
});

test('loaded events are tracked, new events stop during shutdown, and private busy replies avoid handlers', async context => {
    context.mock.method(console, 'log', () => {});
    const client = new EventEmitter();
    const started = pendingWork();
    const release = pendingWork();
    let executions = 0;
    const replies = [];
    client.commands = new Map([['test', { data: { toJSON: () => ({}) }, execute: async () => {
        executions++;
        started.release();
        await release.promise;
    } }]]);
    loadEvents(client);
    const interaction = { commandName: 'test', guildId: 'guild',
        isChatInputCommand: () => true, isMessageContextMenuCommand: () => false,
        reply: async payload => replies.push(payload) };
    client.emit('interactionCreate', interaction);
    await started.promise;
    assert.equal(client.dealBotEventTasks.size, 1);
    let drained = false;
    const draining = drainClientEvents(client).then(() => { drained = true; });
    client.dealBotStopping = true;
    client.emit('interactionCreate', interaction);
    client.emit('threadUpdate', null, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 1);
    assert.equal(drained, false);
    assert.equal(replies[0].ephemeral, true);
    assert.match(replies[0].content, /restarting/);
    release.release();
    await draining;
    assert.equal(client.dealBotEventTasks.size, 0);
});
