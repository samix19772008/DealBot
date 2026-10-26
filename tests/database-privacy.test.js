const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('database initialization keeps newly stored private transcripts and SQLite sidecars owner-only', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-private-db-'));
    const destination = path.join(directory, 'private', 'escrow.sqlite');
    try {
        const child = spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const path = require('node:path');
            const { db, DB_PATH } = require('./src/database/init');
            db.prepare("INSERT INTO guild_settings(guild_id) VALUES ('privacy-fixture')").run();
            const mode = value => fs.statSync(value).mode & 0o777;
            process.stdout.write(JSON.stringify({ directory: mode(path.dirname(DB_PATH)), database: mode(DB_PATH),
                wal: mode(DB_PATH + '-wal'), shm: mode(DB_PATH + '-shm') }));
            db.close();
        `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, DATABASE_PATH: destination } });
        assert.equal(child.status, 0, child.stderr);
        const modes = JSON.parse(child.stdout);
        if (process.platform !== 'win32') assert.deepEqual(modes, { directory: 0o700, database: 0o600, wal: 0o600, shm: 0o600 });
        assert.ok(fs.existsSync(destination));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
