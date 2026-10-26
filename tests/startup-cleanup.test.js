const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function probe(stage) {
    const script = `
        const { EventEmitter } = require('node:events');
        const stage = ${JSON.stringify(stage)};
        const state = { destroyed: 0, closed: 0, initialized: 0, login: 0 };
        const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
        const client = new EventEmitter();
        client.destroy = () => { state.destroyed++; };
        client.login = async () => { state.login++; if(stage==='login') throw new Error('Offline login failure'); return 'not-a-token'; };
        const db = { open: true, close() { this.open = false; state.closed++; } };
        stub('./src/client', client);
        stub('./src/database/init', { db, DB_PATH: '/unused-fixture.sqlite', initDatabase() { state.initialized++; } });
        stub('./src/handlers/commandHandler', { loadCommands() { if(stage==='loader') throw new Error('Offline loader failure'); } });
        stub('./src/handlers/eventHandler', { loadEvents() {}, drainClientEvents: async () => {} });
        stub('./src/handlers/buttonHandler', { loadButtons() {} });
        stub('./src/handlers/modalHandler', { loadModals() {} });
        stub('./src/handlers/selectHandler', { loadSelects() {} });
        const beforeSignals = ['SIGINT','SIGTERM'].map(name => process.listenerCount(name));
        require('./index').start().then(() => { throw new Error('Failure was expected'); }).catch(error => {
            const afterSignals = ['SIGINT','SIGTERM'].map(name => process.listenerCount(name));
            process.stdout.write(JSON.stringify({ ...state, open: db.open, signalListenersRestored: JSON.stringify(beforeSignals)===JSON.stringify(afterSignals), expectedFailure: error.message.includes(stage==='loader' ? 'loader' : 'login') }));
        });
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8',
        env: { PATH: process.env.PATH, DISCORD_TOKEN: 'offline-fixture-placeholder', BACKUP_INTERVAL_HOURS: '0' }, timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
}

test('a command-loader startup failure destroys the client and closes SQLite before any login', () => {
    assert.deepEqual(probe('loader'), { destroyed: 1, closed: 1, initialized: 1, login: 0,
        open: false, signalListenersRestored: true, expectedFailure: true });
});

test('a rejected Discord login runs the same cleanup and removes unused signal listeners', () => {
    assert.deepEqual(probe('login'), { destroyed: 1, closed: 1, initialized: 1, login: 1,
        open: false, signalListenersRestored: true, expectedFailure: true });
});

for (const stage of ['configuration', 'migration']) {
    test(`a database ${stage} failure closes its unexported SQLite connection`, () => {
        const script = `
            const state = { closed: false };
            const stage = ${JSON.stringify(stage)};
            const db = { open: true,
                pragma() { if(stage==='configuration') throw new Error('Fixture configuration failure'); },
                transaction() { return { immediate() { throw new Error('Fixture migration failure'); } }; },
                close() { state.closed = true; this.open = false; }
            };
            const id = require.resolve('better-sqlite3');
            require.cache[id] = { id, filename: id, loaded: true, exports: function Database() { return db; } };
            try { require('./src/database/init'); }
            catch(error) { process.stdout.write(JSON.stringify({ ...state, failed: error.message.includes('Fixture'), open: db.open })); }
        `;
        const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8',
            env: { PATH: process.env.PATH, DATABASE_PATH: ':memory:' }, timeout: 5000 });
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), { closed: true, failed: true, open: false });
    });
}
