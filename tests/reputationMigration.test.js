process.env.DATABASE_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const execute = promisify(execFile);
const root = path.join(__dirname, '..');
const schema = () => fs.readFileSync(path.join(root, 'src/database/schema.sql'), 'utf8');
function legacyFile(filename) {
    const db = new Database(filename);
    db.exec(schema().replace(/CREATE TABLE IF NOT EXISTS guild_user_profiles[\s\S]*$/, ''));
    const addUser = db.prepare(`INSERT INTO users (discord_id, username, account_created_at, trust_score,
        successful_deals, failed_deals, is_scammer, scam_flag_count) VALUES (?, ?, '2020-01-01', 999, 99, 33, 1, 12)`);
    addUser.run('buyer', 'Buyer'); addUser.run('seller', 'Seller'); addUser.run('legacy-only', 'LegacyOnly');
    return db;
}

test('legacy migration imports only attributable server history and leaves unscoped manual claims untouched', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reputation-migration-'));
    const filename = path.join(directory, 'legacy.sqlite');
    try {
        const legacy = legacyFile(filename);
        const insert = legacy.prepare(`INSERT INTO escrow_transactions
            (transaction_uuid, guild_id, buyer_id, seller_id, item_description, amount, currency, status, completed_at, updated_at)
            VALUES (?, ?, ?, ?, 'Legacy item', 10, 'USD', ?, ?, ?)`);
        insert.run('ESC-HISTORY-1', 'guild-a', 1, 2, 'completed', '2026-01-01 10:00:00', '2026-01-01 10:00:00');
        insert.run('ESC-HISTORY-2', 'guild-a', 2, 1, 'completed', '2026-01-01 11:00:00', '2026-01-01 11:00:00');
        insert.run('ESC-HISTORY-3', 'guild-a', 1, 2, 'completed', '2026-01-02 10:00:00', '2026-01-02 10:00:00');
        insert.run('ESC-HISTORY-4', 'guild-b', 1, 2, 'completed', '2026-01-01 10:30:00', '2026-01-01 10:30:00');
        insert.run('ESC-FLAGGED', 'guild-a', 1, 2, 'cancelled', null, '2026-01-03 10:00:00');
        legacy.prepare(`INSERT INTO escrow_events (escrow_id, event_type, to_status, reason)
            VALUES (5, 'scammer_flagged', 'cancelled', 'Flagged participant: seller')`).run();
        legacy.prepare(`INSERT INTO escrow_events (escrow_id, event_type, to_status, reason)
            VALUES (5, 'scammer_flagged', 'cancelled', 'Unattributed legacy moderator note')`).run();
        legacy.close();
        const script = `
            const assert = require('node:assert/strict');
            const { db, initDatabase } = require('./src/database/init');
            const r = require('./src/database/reputationRepository');
            initDatabase(); initDatabase();
            const a = r.getGuildReputation('guild-a', 1);
            assert.equal(a.earned_points, 10); assert.equal(a.successful_deals, 3); assert.equal(a.rank_override_points, null);
            assert.equal(r.getGuildReputation('guild-b', 1).earned_points, 5);
            const seller = r.getGuildReputation('guild-a', 2);
            assert.equal(seller.is_scammer, 1); assert.equal(seller.scam_flag_count, 1); assert.equal(seller.failed_deals, 1);
            assert.equal(r.getGuildReputation('guild-b', 2).is_scammer, 0);
            const noHistory = r.getGuildReputation('guild-a', 3);
            assert.equal(noHistory.earned_points, 0); assert.equal(noHistory.is_scammer, 0); assert.equal(noHistory.trust_score, 0);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escrow_reward_ledger').get().n, 4);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guild_scam_flag_ledger').get().n, 1);
            const old = db.prepare('SELECT * FROM users WHERE id = 1').get();
            assert.equal(old.trust_score, 999); assert.equal(old.successful_deals, 99); assert.equal(old.is_scammer, 1);
            r.clearGuildScamFlag('guild-a', 2, 'reviewer', 'A later evidence review cleared this local flag.');
            initDatabase(); assert.equal(r.getGuildReputation('guild-a', 2).is_scammer, 0);
            db.close();
        `;
        const result = spawnSync(process.execPath, ['-e', script], { cwd: root,
            env: { ...process.env, DATABASE_PATH: filename }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('independent worker processes cannot complete or reward the same delivered deal twice', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reputation-race-'));
    const filename = path.join(directory, 'race.sqlite');
    try {
        const prepare = legacyFile(filename);
        prepare.prepare(`INSERT INTO escrow_transactions
            (transaction_uuid, guild_id, buyer_id, seller_id, item_description, amount, currency, status)
            VALUES ('ESC-RACE', 'guild-race', 1, 2, 'Delivered item', 10, 'USD', 'delivered')`).run();
        prepare.close();
        const script = `
            const { db } = require('./src/database/init');
            const r = require('./src/database/escrowRepository');
            const success = r.completeEscrow(1, 1, 2, 'buyer');
            console.log(success ? 'completed' : 'unchanged'); db.close();
        `;
        const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, ['-e', script], {
            cwd: root, env: { ...process.env, DATABASE_PATH: filename }, timeout: 15000,
        })));
        assert.equal(results.filter(result => result.stdout.trim() === 'completed').length, 1);
        const verify = new Database(filename);
        try {
            assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM escrow_reward_ledger').get().n, 1);
            for (const profile of verify.prepare('SELECT * FROM guild_user_profiles WHERE guild_id = ?').all('guild-race')) {
                assert.equal(profile.earned_points, 5); assert.equal(profile.successful_deals, 1);
            }
            assert.equal(verify.prepare('SELECT trust_score FROM users WHERE id = 1').get().trust_score, 999);
        } finally { verify.close(); }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
