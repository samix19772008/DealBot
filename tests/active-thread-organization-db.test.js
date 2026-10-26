process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { db } = require('../src/database/init');
const deals = require('../src/database/escrowRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
const { getActiveThreadIdleMinutes, setActiveThreadIdleMinutes } = require('../src/database/guildSettingsRepository');
const cleanup = require('../src/database/activeThreadOrganizationRepository');

const NOW = Date.UTC(2026, 9, 26, 12);
const project = path.join(__dirname, '..');
let sequence = 0;
const unique = prefix => `${prefix}-${++sequence}`;
function fixture({ status = 'awaiting_payment', guildId = unique('idle-guild'), channel = true } = {}) {
    const user = prefix => getOrCreateUser({ id: unique(prefix), tag: prefix, createdAt: new Date('2020-01-01') });
    const buyer = user('Buyer');
    const seller = user('Seller');
    const escrow = deals.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Armour Set', amount: 32, currency: 'REDBLOCKS', paymentUnit: 'each' });
    if (channel && status !== 'pending') deals.acceptEscrow(escrow.id, unique('idle-thread'), seller.discord_id);
    db.prepare('UPDATE escrow_transactions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, new Date(NOW - 60 * 60 * 1000).toISOString(), escrow.id);
    return deals.getEscrowById(escrow.id);
}
function claimOne(now = NOW) {
    const jobs = cleanup.claimActiveThreadCleanupJobs({ now });
    assert.equal(jobs.length, 1);
    return jobs[0];
}
function child(script, filename) {
    return spawnSync(process.execPath, ['-e', script], { cwd: project, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, DATABASE_PATH: filename } });
}
function worker(script, filename) {
    return new Promise((resolve, reject) => {
        const process = spawn(global.process.execPath, ['-e', script], { cwd: project,
            env: { ...global.process.env, DATABASE_PATH: filename }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        process.stdout.on('data', data => { stdout += data; });
        process.stderr.on('data', data => { stderr += data; });
        process.on('error', reject);
        process.on('close', code => resolve({ code, stdout, stderr }));
    });
}
beforeEach(() => db.exec('SAVEPOINT active_idle_db_test'));
afterEach(() => db.exec('ROLLBACK TO active_idle_db_test; RELEASE active_idle_db_test'));
after(() => db.close());

test('active conversation policy defaults to fifteen minutes and accepts only supported guild-scoped choices', () => {
    const guildId = unique('idle-policy');
    assert.equal(getActiveThreadIdleMinutes(guildId), 15);
    for (const minutes of [0, 5, 15, 30, 60]) {
        setActiveThreadIdleMinutes(guildId, minutes);
        assert.equal(getActiveThreadIdleMinutes(guildId), minutes);
        assert.equal(getActiveThreadIdleMinutes(unique('other-policy')), 15);
    }
    for (const value of [-1, 1, 10, 1440, '15', null, 15.5, Infinity]) {
        assert.throws(() => setActiveThreadIdleMinutes(guildId, value));
    }
    assert.throws(() => setActiveThreadIdleMinutes('', 15));
});

test('only accepted, funded and delivered deals with threads enter the active-idle queue', () => {
    const eligible = ['awaiting_payment', 'funded', 'delivered'].map(status => fixture({ status }));
    for (const status of ['pending', 'completed', 'cancelled', 'refunded', 'disputed']) fixture({ status });
    fixture({ channel: false });
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    const jobs = cleanup.claimActiveThreadCleanupJobs({ now: NOW, limit: 20 });
    assert.deepEqual(jobs.map(job => job.escrow_id).sort((a, b) => a - b), eligible.map(row => row.id).sort((a, b) => a - b));
    assert.ok(jobs.every(job => job.idleMinutes === 15 && job.lease_token && job.lease_until === NOW + cleanup.LEASE_MS));
    assert.deepEqual(cleanup.claimActiveThreadCleanupJobs({ now: NOW, limit: 20 }), []);
});

test('disabled policies do not seed or claim work and can be enabled without losing existing jobs', t => {
    t.mock.method(Date, 'now', () => NOW);
    const disabled = fixture();
    const enabled = fixture();
    setActiveThreadIdleMinutes(disabled.guild_id, 0);
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    const only = claimOne();
    assert.equal(only.escrow_id, enabled.id);
    cleanup.finishActiveThreadCleanup(only, { archiveTimestamp: NOW, now: NOW });
    setActiveThreadIdleMinutes(disabled.guild_id, 5);
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    assert.equal(claimOne().escrow_id, disabled.id);
});

test('deferred jobs retain their quiet window and stale leases cannot overwrite later claims', () => {
    const escrow = fixture();
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    const first = claimOne();
    assert.equal(cleanup.deferActiveThreadCleanup(first, { dueAt: NOW + 60000, now: NOW }), true);
    assert.deepEqual(cleanup.claimActiveThreadCleanupJobs({ now: NOW + 59999 }), []);
    const next = claimOne(NOW + 60000);
    assert.equal(next.escrow_id, escrow.id);
    assert.notEqual(next.lease_token, first.lease_token);
    assert.equal(cleanup.finishActiveThreadCleanup(first, { archiveTimestamp: NOW + 60000, now: NOW + 60000 }), false);
    assert.equal(cleanup.failActiveThreadCleanup(first, { errorCode: 'OldWorker', now: NOW + 60000 }), false);
    assert.equal(cleanup.deferActiveThreadCleanup(first, { dueAt: NOW + 120000, now: NOW + 60000 }), false);
});

test('expired leases cannot finish work before or after takeover', () => {
    fixture();
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    const first = claimOne();
    assert.equal(cleanup.ownsActiveThreadCleanup(first, { now: NOW + cleanup.LEASE_MS - 1 }), true);
    assert.equal(cleanup.ownsActiveThreadCleanup(first, { now: NOW + cleanup.LEASE_MS }), false);
    assert.equal(cleanup.finishActiveThreadCleanup(first, { archiveTimestamp: NOW, now: NOW + cleanup.LEASE_MS }), false);
    assert.equal(cleanup.deferActiveThreadCleanup(first, { dueAt: NOW + cleanup.LEASE_MS + 60000, now: NOW + cleanup.LEASE_MS }), false);
    const replacement = claimOne(NOW + cleanup.LEASE_MS);
    assert.notEqual(replacement.lease_token, first.lease_token);
});

test('changing a server idle policy invalidates only its active claims', t => {
    t.mock.method(Date, 'now', () => NOW);
    const first = fixture();
    const second = fixture();
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    const jobs = cleanup.claimActiveThreadCleanupJobs({ now: NOW });
    const changed = jobs.find(job => job.escrow_id === first.id);
    const unchanged = jobs.find(job => job.escrow_id === second.id);
    setActiveThreadIdleMinutes(first.guild_id, 0);
    assert.equal(cleanup.ownsActiveThreadCleanup(changed, { now: NOW }), false);
    assert.equal(cleanup.ownsActiveThreadCleanup(unchanged, { now: NOW }), true);
    assert.equal(cleanup.finishActiveThreadCleanup(changed, { archiveTimestamp: NOW, now: NOW }), false);
    assert.deepEqual(cleanup.claimActiveThreadCleanupJobs({ now: NOW }), []);
    setActiveThreadIdleMinutes(first.guild_id, 30);
    assert.equal(claimOne().escrow_id, first.id);
});

test('automatic hiding records a single audit without changing deal state, rewards, closures or transcripts', () => {
    const escrow = fixture({ status: 'funded' });
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    const job = claimOne();
    const rewardBefore = db.prepare('SELECT COUNT(*) AS count FROM escrow_reward_ledger').get().count;
    assert.equal(cleanup.finishActiveThreadCleanup(job, { archiveTimestamp: NOW, automatic: true, actorId: 'idle-bot', now: NOW }), true);
    assert.equal(cleanup.finishActiveThreadCleanup(job, { archiveTimestamp: NOW, automatic: true, actorId: 'idle-bot', now: NOW }), false);
    assert.equal(deals.getEscrowById(escrow.id).status, 'funded');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_reward_ledger').get().count, rewardBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures WHERE escrow_id = ?').get(escrow.id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_delivery_archives WHERE escrow_id = ?').get(escrow.id).count, 0);
    const audits = deals.getEscrowEvents(escrow.id).filter(event => event.event_type === 'thread_idle_archived');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_discord_id, 'idle-bot');
    assert.equal(audits[0].from_status, 'funded');
    assert.equal(audits[0].to_status, 'funded');
});

test('existing archives and missing sources complete bookkeeping without inventing an automatic action', () => {
    for (const status of ['archived', 'unavailable']) {
        const escrow = fixture();
        cleanup.seedActiveThreadCleanupJobs({ now: NOW });
        assert.equal(cleanup.finishActiveThreadCleanup(claimOne(), { status, archiveTimestamp: status === 'archived' ? NOW : null, now: NOW }), true);
        assert.equal(deals.getEscrowEvents(escrow.id).filter(event => event.event_type === 'thread_idle_archived').length, 0);
    }
});

test('a dispute or terminal transition prevents both claiming and finishing an earlier idle decision', () => {
    for (const status of ['disputed', 'completed', 'cancelled', 'refunded', 'pending']) {
        const escrow = fixture();
        cleanup.seedActiveThreadCleanupJobs({ now: NOW });
        const job = claimOne();
        db.prepare('UPDATE escrow_transactions SET status = ? WHERE id = ?').run(status, escrow.id);
        assert.equal(cleanup.finishActiveThreadCleanup(job, { archiveTimestamp: NOW, automatic: true, actorId: 'idle-bot', now: NOW }), false);
        assert.deepEqual(cleanup.claimActiveThreadCleanupJobs({ now: NOW + cleanup.LEASE_MS }), []);
    }
});

test('reopening an active thread gives a new idle window without rescheduling finished or disputed deals', () => {
    const escrow = fixture();
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    cleanup.finishActiveThreadCleanup(claimOne(), { archiveTimestamp: NOW, now: NOW });
    assert.equal(cleanup.rescheduleActiveThreadCleanup(escrow.id, { now: NOW + 1000 }), true);
    assert.deepEqual(cleanup.claimActiveThreadCleanupJobs({ now: NOW + 15 * 60000 }), []);
    assert.equal(claimOne(NOW + 15 * 60000 + 1000).escrow_id, escrow.id);
    for (const status of ['disputed', 'completed', 'cancelled', 'refunded', 'pending']) {
        assert.equal(cleanup.rescheduleActiveThreadCleanup(fixture({ status }).id, { now: NOW }), false);
    }
});

test('retry backoff survives scheduling and stores only a bounded error code', () => {
    const escrow = fixture();
    cleanup.seedActiveThreadCleanupJobs({ now: NOW });
    const job = claimOne();
    assert.equal(cleanup.failActiveThreadCleanup({ ...job, attempts: 1000 }, { errorCode: { code: '<Invalid>\n'.repeat(100) }, now: NOW }), true);
    const stored = db.prepare('SELECT * FROM deal_active_thread_cleanup WHERE escrow_id = ?').get(escrow.id);
    assert.equal(stored.due_at, NOW + 86400000);
    assert.match(stored.last_error, /^[A-Za-z0-9_.:-]{1,100}$/);
    assert.equal(stored.lease_token, null);
    assert.equal(cleanup.claimActiveThreadCleanupJobs({ now: NOW + 86400000 }).length, 1);
});

test('legacy guild settings receive the additive idle default while saved hub, roles and data survive', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-active-idle-upgrade-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'legacy.sqlite');
    const prepared = child(`
        const {db}=require('./src/database/init');
        db.prepare('INSERT INTO guild_settings(guild_id,hub_channel_id,moderator_role_id) VALUES (?,?,?)').run('legacy','hub','staff');
        db.exec('DROP TABLE deal_active_thread_cleanup; ALTER TABLE guild_settings DROP COLUMN active_thread_idle_minutes');
        db.close();
    `, filename);
    assert.equal(prepared.status, 0, prepared.stderr);
    const migrated = child(`
        const {db,initDatabase}=require('./src/database/init');initDatabase();
        const {getGuildSettings,getActiveThreadIdleMinutes}=require('./src/database/guildSettingsRepository');
        process.stdout.write(JSON.stringify({settings:getGuildSettings('legacy'),idle:getActiveThreadIdleMinutes('legacy'),integrity:db.pragma('integrity_check',{simple:true}),foreignKeys:db.pragma('foreign_key_check')}));db.close();
    `, filename);
    assert.equal(migrated.status, 0, migrated.stderr);
    const result = JSON.parse(migrated.stdout);
    assert.equal(result.settings.hub_channel_id, 'hub');
    assert.equal(result.settings.moderator_role_id, 'staff');
    assert.equal(result.idle, 15);
    assert.equal(result.integrity, 'ok');
    assert.deepEqual(result.foreignKeys, []);
});

test('concurrent Node processes share one durable idle lease after process restart', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-active-idle-claims-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'shared.sqlite');
    const prepared = child(`
        const {db}=require('./src/database/init');const {getOrCreateUser}=require('./src/database/userRepository');
        const deals=require('./src/database/escrowRepository');
        const user=id=>getOrCreateUser({id,tag:id,createdAt:new Date('2020-01-01')});
        const buyer=user('buyer'),seller=user('seller');
        const deal=deals.createEscrow({guildId:'shared',buyerId:buyer.id,sellerId:seller.id,itemDescription:'Armour',amount:1});
        deals.acceptEscrow(deal.id,'private-thread','seller');
        db.prepare('UPDATE escrow_transactions SET updated_at=?').run(new Date(${NOW}-3600000).toISOString());
        require('./src/database/activeThreadOrganizationRepository').seedActiveThreadCleanupJobs({now:${NOW}});db.close();
    `, filename);
    assert.equal(prepared.status, 0, prepared.stderr);
    const script = `const cleanup=require('./src/database/activeThreadOrganizationRepository');process.stdout.write(JSON.stringify(cleanup.claimActiveThreadCleanupJobs({now:${NOW}}).map(job=>job.lease_token)));require('./src/database/init').db.close();`;
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => worker(script, filename)));
    for (const result of outcomes) assert.equal(result.code, 0, result.stderr);
    assert.equal(outcomes.flatMap(result => JSON.parse(result.stdout)).length, 1);
});
