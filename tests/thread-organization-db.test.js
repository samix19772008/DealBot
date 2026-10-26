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
const { getGuildSettings, getThreadCleanupMinutes, setThreadCleanupMinutes } = require('../src/database/guildSettingsRepository');
const cleanup = require('../src/database/threadOrganizationRepository');

const NOW = Date.UTC(2026, 9, 26, 12);
const project = path.join(__dirname, '..');
let sequence = 0;
const next = prefix => `${prefix}-${++sequence}`;
function user(name) {
    return getOrCreateUser({ id: next('organization-user'), tag: name, createdAt: new Date('2020-01-01') });
}
function fixture({ status = 'completed', guildId = next('organization-guild'), buyer = user('Buyer'), seller = user('Seller'), channel = true } = {}) {
    let escrow = deals.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'A gaming item', amount: 2, currency: 'USD' });
    if (channel && status !== 'pending') deals.acceptEscrow(escrow.id, next('organization-thread'), seller.discord_id);
    if (['funded', 'delivered', 'completed', 'disputed', 'cancelled', 'refunded'].includes(status) && channel) {
        deals.markAsFunded(escrow.id, buyer.discord_id);
    }
    if (['delivered', 'completed'].includes(status)) deals.markAsDelivered(escrow.id, seller.discord_id);
    if (status === 'completed') deals.completeEscrow(escrow.id, buyer.id, seller.id, buyer.discord_id);
    if (['disputed', 'cancelled'].includes(status) && channel) {
        deals.markAsDisputed(escrow.id, 'A clear dispute reason for this test.', buyer.discord_id);
        if (status === 'cancelled') deals.cancelEscrow(escrow.id, { expectedStatus: 'disputed', actorId: seller.discord_id });
    }
    if (status === 'cancelled' && !channel) deals.cancelEscrow(escrow.id, { actorId: buyer.discord_id });
    if (status === 'refunded') db.prepare("UPDATE escrow_transactions SET status = 'refunded' WHERE id = ?").run(escrow.id);
    db.prepare('UPDATE escrow_transactions SET updated_at = ? WHERE id = ?')
        .run(new Date(NOW - 60 * 60 * 1000).toISOString(), escrow.id);
    escrow = deals.getEscrowById(escrow.id);
    return { guildId, buyer, seller, escrow };
}
function onlyJob() {
    const jobs = cleanup.claimThreadCleanupJobs({ now: NOW, limit: 5 });
    assert.equal(jobs.length, 1);
    return jobs[0];
}
function child(script, filename) {
    return spawnSync(process.execPath, ['-e', script], { cwd: project,
        env: { ...process.env, DATABASE_PATH: filename }, encoding: 'utf8', timeout: 10000 });
}
function worker(script, filename) {
    return new Promise((resolve, reject) => {
        const process = spawn(global.process.execPath, ['-e', script], { cwd: project,
            env: { ...global.process.env, DATABASE_PATH: filename }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        process.stdout.on('data', data => { stdout += data; });
        process.stderr.on('data', data => { stderr += data; });
        process.on('error', reject);
        process.on('close', code => resolve({ code, stdout, stderr }));
    });
}

beforeEach(() => db.exec('SAVEPOINT organization_test'));
afterEach(() => db.exec('ROLLBACK TO organization_test; RELEASE organization_test'));
after(() => db.close());

test('attention lists and counts show only actions assigned to the current participant in this server', () => {
    const guildId = next('attention-guild');
    const buyer = user('Buyer');
    const seller = user('Seller');
    const rows = Object.fromEntries(['pending', 'awaiting_payment', 'funded', 'delivered', 'disputed', 'completed', 'cancelled']
        .map(status => [status, fixture({ guildId, buyer, seller, status }).escrow]));
    fixture({ guildId: next('other-guild'), buyer, seller, status: 'delivered' });
    fixture({ guildId, status: 'pending' });
    const ids = (id, status) => deals.listEscrowsForUser(guildId, id, { status, limit: 25 }).map(row => row.id).sort((a, b) => a - b);
    assert.deepEqual(ids(buyer.discord_id, 'attention'), [rows.awaiting_payment.id, rows.delivered.id].sort((a, b) => a - b));
    assert.deepEqual(ids(seller.discord_id, 'attention'), [rows.pending.id, rows.funded.id].sort((a, b) => a - b));
    assert.equal(deals.countEscrowsForUser(guildId, buyer.discord_id, { status: 'attention' }), 2);
    assert.equal(deals.countEscrowsForUser(guildId, seller.discord_id, { status: 'attention' }), 2);
    assert.equal(deals.countEscrowsForUser(guildId, buyer.discord_id, { status: 'active' }), 5);
    assert.equal(deals.countEscrowsForUser(guildId, buyer.discord_id, { status: 'completed' }), 1);
    assert.equal(deals.countEscrowsForUser(guildId, buyer.discord_id, { status: 'all' }), 7);
    assert.equal(deals.countEscrowsForUser(guildId, 'outsider', { status: 'all' }), 0);
    assert.equal(deals.countEscrowsForUser('', buyer.discord_id, { status: 'all' }), 0);
    assert.equal(deals.countEscrowsForUser(guildId, buyer.discord_id, { status: 'bogus' }), 0);
});

test('cleanup settings default to thirty minutes, accept the documented choices, and do not affect another server', () => {
    const guildId = next('settings-guild');
    assert.equal(getThreadCleanupMinutes(guildId), 30);
    for (const minutes of [0, 15, 30, 60, 1440]) {
        setThreadCleanupMinutes(guildId, minutes);
        assert.equal(getThreadCleanupMinutes(guildId), minutes);
    }
    assert.equal(getThreadCleanupMinutes(next('other-guild')), 30);
    for (const minutes of [-1, 1, 29, 31, 1.5, Infinity, NaN, '30', null]) {
        assert.throws(() => setThreadCleanupMinutes(guildId, minutes));
    }
    assert.throws(() => setThreadCleanupMinutes('', 30));
});

test('seeding is repeatable and only terminal deals with actual conversation IDs become due jobs', () => {
    const ended = ['completed', 'cancelled', 'refunded'].map(status => fixture({ status }));
    for (const status of ['pending', 'awaiting_payment', 'funded', 'delivered', 'disputed']) fixture({ status });
    fixture({ status: 'cancelled', channel: false });
    cleanup.seedThreadCleanupJobs({ now: NOW });
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const claimed = cleanup.claimThreadCleanupJobs({ now: NOW, limit: 10 });
    assert.deepEqual(claimed.map(job => job.escrow.id).sort((a, b) => a - b), ended.map(f => f.escrow.id).sort((a, b) => a - b));
    assert.ok(claimed.every(job => job.cleanupMinutes === 30 && job.lease_token && job.lease_until > NOW));
    assert.deepEqual(cleanup.claimThreadCleanupJobs({ now: NOW, limit: 10 }), []);
});

test('disabled guild cleanup cannot block enabled jobs, and changing policy rechecks pending jobs', () => {
    const disabled = fixture();
    const enabled = fixture();
    setThreadCleanupMinutes(disabled.guildId, 0);
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const first = onlyJob();
    assert.equal(first.escrow.id, enabled.escrow.id);
    cleanup.finishThreadCleanup(first, { archiveTimestamp: NOW, now: NOW });
    setThreadCleanupMinutes(disabled.guildId, 15);
    // Each worker tick seeds newly eligible terminal conversations, including
    // servers that have just enabled cleanup.
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const restored = onlyJob();
    assert.equal(restored.escrow.id, disabled.escrow.id);
    assert.equal(restored.cleanupMinutes, 15);
});

test('deferral protects newly active terminal conversations and old leases cannot change another claim', () => {
    const f = fixture();
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const first = onlyJob();
    assert.equal(cleanup.deferThreadCleanup(first, { dueAt: NOW + 60000, now: NOW }), true);
    assert.deepEqual(cleanup.claimThreadCleanupJobs({ now: NOW + 59999 }), []);
    const [second] = cleanup.claimThreadCleanupJobs({ now: NOW + 60000 });
    assert.equal(second.escrow.id, f.escrow.id);
    assert.notEqual(second.lease_token, first.lease_token);
    assert.equal(cleanup.finishThreadCleanup(first, { archiveTimestamp: NOW, now: NOW + 60000 }), false);
    assert.equal(cleanup.failThreadCleanup(first, { errorCode: 'StaleLease', now: NOW + 60000 }), false);
    assert.equal(cleanup.deferThreadCleanup(first, { dueAt: NOW + 90000, now: NOW + 60000 }), false);
});

test('failed work backs off durably and retry completion records one automatic-archive audit without changing deal state', () => {
    const f = fixture();
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const first = onlyJob();
    assert.equal(cleanup.failThreadCleanup(first, { errorCode: 'DiscordUnavailable', now: NOW }), true);
    assert.deepEqual(cleanup.claimThreadCleanupJobs({ now: NOW }), []);
    const candidates = cleanup.claimThreadCleanupJobs({ now: NOW + 86400000 });
    assert.equal(candidates.length, 1);
    const second = candidates[0];
    assert.ok(second.attempts > first.attempts);
    assert.equal(cleanup.finishThreadCleanup(second, { archiveTimestamp: NOW + 86400000, automatic: true,
        actorId: 'cleanup-bot', reason: 'Terminal conversation inactivity cleanup', now: NOW + 86400000 }), true);
    assert.equal(cleanup.finishThreadCleanup(second, { archiveTimestamp: NOW + 86400000, automatic: true,
        actorId: 'cleanup-bot', reason: 'Duplicate completion', now: NOW + 86400000 }), false);
    const audits = deals.getEscrowEvents(f.escrow.id).filter(event => event.event_type === 'thread_auto_archived');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_discord_id, 'cleanup-bot');
    assert.equal(deals.getEscrowById(f.escrow.id).status, 'completed');
    assert.deepEqual(cleanup.claimThreadCleanupJobs({ now: NOW + 172800000 }), []);
});

test('already archived and unavailable sources do not invent an automatic-archive audit', () => {
    for (const status of ['archived', 'unavailable']) {
        const f = fixture();
        cleanup.seedThreadCleanupJobs({ now: NOW });
        const job = onlyJob();
        assert.equal(cleanup.finishThreadCleanup(job, { archiveTimestamp: status === 'archived' ? NOW : null,
            status, automatic: false, now: NOW }), true);
        assert.equal(deals.getEscrowEvents(f.escrow.id).filter(event => event.event_type === 'thread_auto_archived').length, 0);
    }
});

test('reopening a terminal thread schedules a fresh quiet window while active deal states stay outside cleanup', () => {
    const f = fixture();
    cleanup.seedThreadCleanupJobs({ now: NOW });
    cleanup.finishThreadCleanup(onlyJob(), { archiveTimestamp: NOW, now: NOW });
    assert.equal(cleanup.rescheduleThreadCleanup(f.escrow.id, { now: NOW + 10000 }), true);
    assert.deepEqual(cleanup.claimThreadCleanupJobs({ now: NOW + 30 * 60000 + 9999 }), []);
    const [job] = cleanup.claimThreadCleanupJobs({ now: NOW + 30 * 60000 + 10000 });
    assert.equal(job.escrow.id, f.escrow.id);
    const active = fixture({ status: 'funded' });
    assert.equal(cleanup.rescheduleThreadCleanup(active.escrow.id, { now: NOW }), false);
});

test('changing a server policy invalidates its in-flight lease without touching another server', t => {
    t.mock.method(Date, 'now', () => NOW);
    const first = fixture();
    const other = fixture();
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const jobs = cleanup.claimThreadCleanupJobs({ now: NOW });
    const old = jobs.find(job => job.escrow_id === first.escrow.id);
    const untouched = jobs.find(job => job.escrow_id === other.escrow.id);
    assert.equal(cleanup.ownsThreadCleanup(old, { now: NOW }), true);
    setThreadCleanupMinutes(first.guildId, 0);
    assert.equal(cleanup.ownsThreadCleanup(old, { now: NOW }), false);
    assert.equal(cleanup.ownsThreadCleanup(untouched, { now: NOW }), true);
    assert.equal(cleanup.finishThreadCleanup(old, { archiveTimestamp: NOW, automatic: true,
        actorId: 'cleanup-bot', now: NOW }), false);
    assert.deepEqual(cleanup.claimThreadCleanupJobs({ now: NOW }), []);
    setThreadCleanupMinutes(first.guildId, 60);
    const [replacement] = cleanup.claimThreadCleanupJobs({ now: NOW });
    assert.equal(replacement.escrow_id, first.escrow.id);
    assert.equal(replacement.cleanupMinutes, 60);
    assert.notEqual(replacement.lease_token, old.lease_token);
    assert.equal(deals.getEscrowEvents(first.escrow.id).filter(event => event.event_type === 'thread_auto_archived').length, 0);
});

test('an expired worker cannot finish or defer a job even before another worker claims it', () => {
    fixture();
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const old = onlyJob();
    const expires = NOW + cleanup.LEASE_MS;
    assert.equal(cleanup.ownsThreadCleanup(old, { now: expires - 1 }), true);
    assert.equal(cleanup.ownsThreadCleanup(old, { now: expires }), false);
    assert.equal(cleanup.finishThreadCleanup(old, { archiveTimestamp: expires, now: expires }), false);
    assert.equal(cleanup.deferThreadCleanup(old, { dueAt: expires + 60000, now: expires }), false);
    assert.equal(cleanup.failThreadCleanup(old, { errorCode: 'Expired', now: expires }), false);
    const [nextClaim] = cleanup.claimThreadCleanupJobs({ now: expires });
    assert.ok(nextClaim);
    assert.notEqual(nextClaim.lease_token, old.lease_token);
});

test('a job cannot be claimed or finished after its deal has returned to an active or disputed state', () => {
    for (const status of ['awaiting_payment', 'funded', 'delivered', 'disputed']) {
        const f = fixture();
        cleanup.seedThreadCleanupJobs({ now: NOW });
        const claimed = onlyJob();
        db.prepare('UPDATE escrow_transactions SET status = ? WHERE id = ?').run(status, f.escrow.id);
        assert.equal(cleanup.finishThreadCleanup(claimed, { archiveTimestamp: NOW, automatic: true,
            actorId: 'cleanup-bot', now: NOW }), false);
        assert.deepEqual(cleanup.claimThreadCleanupJobs({ now: NOW + cleanup.LEASE_MS }), []);
        db.prepare('DELETE FROM deal_thread_cleanup WHERE escrow_id = ?').run(f.escrow.id);
    }
});

test('retry errors retain only a bounded code and exponential backoff never exceeds one day', () => {
    fixture();
    cleanup.seedThreadCleanupJobs({ now: NOW });
    const initial = onlyJob();
    db.prepare('UPDATE deal_thread_cleanup SET attempts = 500 WHERE escrow_id = ?').run(initial.escrow_id);
    const job = { ...initial, attempts: 500 };
    assert.equal(cleanup.failThreadCleanup(job, { errorCode: { code: '<DiscordError>\n'.repeat(30) }, now: NOW }), true);
    const row = db.prepare('SELECT * FROM deal_thread_cleanup WHERE escrow_id = ?').get(job.escrow_id);
    assert.equal(row.due_at, NOW + 86400000);
    assert.ok(row.last_error.length <= 100);
    assert.match(row.last_error, /^[A-Za-z0-9_.:-]+$/);
});

test('invalid worker timestamps are rejected before changing cleanup state', () => {
    for (const now of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => cleanup.seedThreadCleanupJobs({ now }));
        assert.throws(() => cleanup.claimThreadCleanupJobs({ now }));
    }
});

test('legacy server settings migrate additively and existing configured values survive repeated initialization', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-thread-settings-'));
    const filename = path.join(directory, 'legacy.sqlite');
    try {
        const Database = require('better-sqlite3');
        const legacy = new Database(filename);
        legacy.exec(`CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, moderator_role_id TEXT,
            hub_channel_id TEXT, language TEXT DEFAULT 'en', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        legacy.prepare('INSERT INTO guild_settings (guild_id, moderator_role_id, hub_channel_id) VALUES (?, ?, ?)')
            .run('legacy-guild', 'legacy-staff', 'legacy-hub');
        legacy.close();
        const result = child(`
            const assert = require('node:assert/strict');
            const { db, initDatabase } = require('./src/database/init');
            const settings = require('./src/database/guildSettingsRepository');
            assert.equal(settings.getThreadCleanupMinutes('legacy-guild'),30);
            settings.setThreadCleanupMinutes('legacy-guild',60);
            initDatabase(); initDatabase();
            const row=settings.getGuildSettings('legacy-guild');
            assert.equal(row.thread_cleanup_minutes,60);
            assert.equal(row.moderator_role_id,'legacy-staff');
            assert.equal(row.hub_channel_id,'legacy-hub');
            assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
            assert.deepEqual(db.pragma('foreign_key_check'),[]);
            db.close();
        `, filename);
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('simultaneous worker processes claim one saved cleanup job only once', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-thread-cleanup-race-'));
    const filename = path.join(directory, 'cleanup.sqlite');
    try {
        const initialized = child(`
            const {db}=require('./src/database/init');
            const {getOrCreateUser}=require('./src/database/userRepository');
            const r=require('./src/database/escrowRepository');
            const b=getOrCreateUser({id:'race-buyer',tag:'Buyer',createdAt:new Date('2020-01-01')});
            const s=getOrCreateUser({id:'race-seller',tag:'Seller',createdAt:new Date('2020-01-01')});
            const e=r.createEscrow({guildId:'race-guild',buyerId:b.id,sellerId:s.id,itemDescription:'Cape',amount:2});
            r.acceptEscrow(e.id,'race-thread',s.discord_id); r.markAsFunded(e.id,b.discord_id);
            r.markAsDelivered(e.id,s.discord_id);r.completeEscrow(e.id,b.id,s.id,b.discord_id);
            db.prepare("UPDATE escrow_transactions SET updated_at='2020-01-01 00:00:00' WHERE id=?").run(e.id);
            require('./src/database/threadOrganizationRepository').seedThreadCleanupJobs({now:${NOW}});
            db.close();
        `, filename);
        assert.equal(initialized.status, 0, initialized.stderr);
        const results = await Promise.all(Array.from({ length: 4 }, () => worker(`
            const r=require('./src/database/threadOrganizationRepository');
            console.log(JSON.stringify(r.claimThreadCleanupJobs({limit:1,now:${NOW}}).map(job=>job.escrow.id)));
            require('./src/database/init').db.close();
        `, filename)));
        for (const result of results) assert.equal(result.code, 0, result.stderr);
        assert.equal(results.filter(result => JSON.parse(result.stdout).length === 1).length, 1);
        assert.equal(results.filter(result => JSON.parse(result.stdout).length === 0).length, 3);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
