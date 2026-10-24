const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

process.env.DATABASE_PATH = ':memory:';
const { db } = require('../src/database/init');
const policy = require('../src/database/offerPolicyRepository');
const escrows = require('../src/database/escrowRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
let sequence = 0;
const project = path.join(__dirname, '..');

function user() {
    sequence += 1;
    return getOrCreateUser({ id: `policy-user-${sequence}`, tag: `Trader ${sequence}`, createdAt: new Date('2020-01-01') });
}
function fixture(guildId = `policy-guild-${++sequence}`, buyer = user(), seller = user()) {
    const deal = escrows.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Trade item', amount: 5, currency: 'USD' });
    return { guildId, buyer, seller, deal };
}
function datedDeal(guildId, createdAt, status = 'pending', { deferDate = false } = {}) {
    const f = fixture(guildId);
    if (status !== 'pending') escrows.acceptEscrow(f.deal.id, `thread-${f.deal.id}`, f.seller.discord_id);
    if (['funded', 'delivered', 'disputed'].includes(status)) escrows.markAsFunded(f.deal.id, f.buyer.discord_id);
    if (status === 'delivered') escrows.markAsDelivered(f.deal.id, f.seller.discord_id);
    if (status === 'disputed') escrows.markAsDisputed(f.deal.id, 'A meaningful dispute reason', f.buyer.discord_id);
    const setCreatedAt = () => db.prepare('UPDATE escrow_transactions SET created_at = ? WHERE id = ?').run(createdAt, f.deal.id);
    if (!deferDate) setCreatedAt();
    return { ...f, setCreatedAt };
}
function child(script, filename) {
    return spawnSync(process.execPath, ['-e', script], {
        cwd: project, env: { ...process.env, DATABASE_PATH: filename }, encoding: 'utf8',
    });
}
function asyncChild(script, filename) {
    return new Promise((resolve, reject) => {
        const childProcess = spawn(process.execPath, ['-e', script], {
            cwd: project, env: { ...process.env, DATABASE_PATH: filename }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        childProcess.stdout.on('data', data => { stdout += data; });
        childProcess.stderr.on('data', data => { stderr += data; });
        childProcess.on('error', reject);
        childProcess.on('close', code => resolve({ status: code, stdout, stderr }));
    });
}

after(() => db.close());

test('cooldown reports exact remaining time and permits the boundary after 15 seconds', () => {
    assert.deepEqual(policy.acquireOfferCooldown('cooldown-boundary', 'buyer', { now: 100000 }), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(policy.acquireOfferCooldown('cooldown-boundary', 'buyer', { now: 100500 }), { allowed: false, retryAfterMs: 14500 });
    assert.deepEqual(policy.acquireOfferCooldown('cooldown-boundary', 'buyer', { now: 114999 }), { allowed: false, retryAfterMs: 1 });
    assert.deepEqual(policy.acquireOfferCooldown('cooldown-boundary', 'buyer', { now: 115000 }), { allowed: true, retryAfterMs: 0 });
});

test('cooldowns are isolated by server and buyer and reject invalid policy inputs', () => {
    assert.equal(policy.acquireOfferCooldown('cooldown-server-a', 'buyer-one', { now: 100000 }).allowed, true);
    assert.equal(policy.acquireOfferCooldown('cooldown-server-b', 'buyer-one', { now: 100000 }).allowed, true);
    assert.equal(policy.acquireOfferCooldown('cooldown-server-a', 'buyer-two', { now: 100000 }).allowed, true);
    assert.equal(policy.acquireOfferCooldown('cooldown-server-a', 'buyer-one', { now: 100001 }).allowed, false);
    for (const now of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => policy.acquireOfferCooldown('guild', 'buyer', { now }), /timestamp/);
        assert.throws(() => policy.expirePendingOffers({ now }), /timestamp/);
    }
    assert.throws(() => policy.acquireOfferCooldown('', 'buyer'), /server ID/);
    assert.throws(() => policy.acquireOfferCooldown('guild', ''), /buyer ID/);
});

test('a saved cooldown survives module reloads and a fresh Node process', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-cooldown-'));
    const filename = path.join(directory, 'policy.sqlite');
    try {
        const first = child(`
            const p = require('./src/database/offerPolicyRepository');
            console.log(JSON.stringify(p.acquireOfferCooldown('persist-guild', 'persist-buyer', {now: 100000})));
            delete require.cache[require.resolve('./src/database/offerPolicyRepository')];
            console.log(JSON.stringify(require('./src/database/offerPolicyRepository').acquireOfferCooldown('persist-guild', 'persist-buyer', {now: 100001})));
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(first.status, 0, first.stderr);
        assert.deepEqual(first.stdout.trim().split('\n').map(JSON.parse), [
            { allowed: true, retryAfterMs: 0 }, { allowed: false, retryAfterMs: 14999 },
        ]);
        const restarted = child(`
            console.log(JSON.stringify(require('./src/database/offerPolicyRepository').acquireOfferCooldown('persist-guild', 'persist-buyer', {now: 105000})));
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(restarted.status, 0, restarted.stderr);
        assert.deepEqual(JSON.parse(restarted.stdout), { allowed: false, retryAfterMs: 10000 });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('simultaneous worker processes acquire one persistent cooldown rather than each passing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-cooldown-race-'));
    const filename = path.join(directory, 'policy.sqlite');
    try {
        const initialized = child("require('./src/database/offerPolicyRepository'); require('./src/database/init').db.close();", filename);
        assert.equal(initialized.status, 0, initialized.stderr);
        const results = await Promise.all(Array.from({ length: 4 }, () => asyncChild(`
            console.log(JSON.stringify(require('./src/database/offerPolicyRepository').acquireOfferCooldown('race-guild', 'race-buyer', {now: 100000})));
            require('./src/database/init').db.close();
        `, filename)));
        for (const result of results) assert.equal(result.status, 0, result.stderr);
        const acquisitions = results.map(result => JSON.parse(result.stdout));
        assert.equal(acquisitions.filter(result => result.allowed).length, 1);
        assert.equal(acquisitions.filter(result => !result.allowed && result.retryAfterMs === 15000).length, 3);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('only pending offers at least 24 hours old expire, with one audit event and a reason', () => {
    const now = Date.UTC(2020, 0, 2);
    const guildId = 'expiry-boundary-guild';
    const beforeBoundary = datedDeal(guildId, new Date(now - policy.PENDING_OFFER_TTL_MS + 1).toISOString(), 'pending', { deferDate: true });
    const boundary = datedDeal(guildId, new Date(now - policy.PENDING_OFFER_TTL_MS).toISOString(), 'pending', { deferDate: true });
    const older = datedDeal(guildId, new Date(now - policy.PENDING_OFFER_TTL_MS - 1).toISOString(), 'pending', { deferDate: true });
    const dated = [beforeBoundary, boundary, older];
    for (const status of ['awaiting_payment', 'funded', 'delivered', 'disputed']) {
        const active = datedDeal(guildId, '2019-01-01T00:00:00.000Z', status, { deferDate: true });
        dated.push(active);
        assert.equal(escrows.getEscrowById(active.deal.id).status, status);
    }
    for (const f of dated) f.setCreatedAt();
    assert.equal(policy.expirePendingOffers({ guildId, now }), 2);
    assert.equal(escrows.getEscrowById(beforeBoundary.deal.id).status, 'pending');
    for (const expired of [boundary, older]) {
        assert.equal(escrows.getEscrowById(expired.deal.id).status, 'cancelled');
        const events = escrows.getEscrowEvents(expired.deal.id);
        assert.equal(events.filter(event => event.event_type === 'offer_expired').length, 1);
        const event = events.find(event => event.event_type === 'offer_expired');
        assert.equal(event.from_status, 'pending');
        assert.equal(event.to_status, 'cancelled');
        assert.equal(event.actor_discord_id, null);
        assert.match(event.reason, /24 hours/);
        assert.equal(event.created_at, new Date(now).toISOString().replace('T', ' ').replace(/Z$/, ''));
    }
    assert.equal(policy.expirePendingOffers({ guildId, now }), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM escrow_transactions WHERE guild_id = ? AND status IN ('awaiting_payment','funded','delivered','disputed')").get(guildId).count, 4);
});

test('scoped expiry leaves other servers untouched and global maintenance expires the rest', () => {
    const now = Date.UTC(2010, 0, 2);
    const a = datedDeal('expiry-guild-a', '2009-01-01T00:00:00.000Z');
    const b = datedDeal('expiry-guild-b', '2009-01-01T00:00:00.000Z');
    assert.equal(policy.expirePendingOffers({ guildId: a.guildId, now }), 1);
    assert.equal(escrows.getEscrowById(b.deal.id).status, 'pending');
    assert.equal(policy.expirePendingOffers({ now }), 1);
    assert.equal(escrows.getEscrowById(b.deal.id).status, 'cancelled');
});

test('an expiry audit-write failure rolls cancellation back instead of losing history', () => {
    const f = datedDeal('expiry-rollback-guild', '2000-01-01T00:00:00.000Z');
    db.exec(`CREATE TEMP TRIGGER block_offer_expiry BEFORE INSERT ON escrow_events
        WHEN NEW.event_type = 'offer_expired' BEGIN SELECT RAISE(ABORT, 'Expiry audit failure'); END;`);
    try {
        assert.throws(() => policy.expirePendingOffers({ guildId: f.guildId }), /Expiry audit failure/);
        assert.equal(escrows.getEscrowById(f.deal.id).status, 'pending');
        assert.equal(escrows.getEscrowEvents(f.deal.id).filter(event => event.event_type === 'offer_expired').length, 0);
    } finally {
        db.exec('DROP TRIGGER block_offer_expiry');
    }
    assert.equal(policy.expirePendingOffers({ guildId: f.guildId }), 1);
});

test('the active-deal guard includes seller participation, isolates guilds, and excludes ended deals', () => {
    const buyer = user();
    const seller = user();
    const guildId = 'cap-guard-guild';
    const pending = [];
    for (let i = 0; i < 10; i++) pending.push(fixture(guildId, buyer, seller).deal);
    assert.throws(() => policy.assertActiveDealLimit(guildId, buyer.id), error => error.code === 'ACTIVE_DEAL_LIMIT');
    assert.throws(() => policy.assertActiveDealLimit(guildId, seller.id), /10 active deals/);
    assert.equal(policy.assertActiveDealLimit('another-cap-guild', buyer.id), 0);
    escrows.cancelEscrow(pending[0].id);
    assert.equal(policy.assertActiveDealLimit(guildId, buyer.id), 9);
});

test('simultaneous create operations cannot exceed the active-deal cap', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-cap-race-'));
    const filename = path.join(directory, 'policy.sqlite');
    try {
        const setup = child(`
            const { getOrCreateUser } = require('./src/database/userRepository');
            const { createEscrow } = require('./src/database/escrowRepository');
            const b = getOrCreateUser({id:'race-buyer',tag:'Buyer',createdAt:new Date('2020-01-01')});
            const s = getOrCreateUser({id:'race-seller',tag:'Seller',createdAt:new Date('2020-01-01')});
            for(let i=0;i<9;i++) createEscrow({guildId:'cap-race',buyerId:b.id,sellerId:s.id,itemDescription:'Item',amount:5,currency:'USD'});
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(setup.status, 0, setup.stderr);
        const results = await Promise.all(Array.from({ length: 4 }, () => asyncChild(`
            const { db } = require('./src/database/init');
            const { createEscrow } = require('./src/database/escrowRepository');
            const b = db.prepare("SELECT id FROM users WHERE discord_id='race-buyer'").get();
            const s = db.prepare("SELECT id FROM users WHERE discord_id='race-seller'").get();
            try {
                createEscrow({guildId:'cap-race',buyerId:b.id,sellerId:s.id,itemDescription:'Contended item',amount:5,currency:'USD'});
                console.log('created');
            } catch(error) {
                if(error.code !== 'ACTIVE_DEAL_LIMIT' && !/10 active deals/.test(error.message)) throw error;
                console.log('limited');
            }
            db.close();
        `, filename)));
        for (const result of results) assert.equal(result.status, 0, result.stderr);
        assert.equal(results.filter(result => result.stdout.trim() === 'created').length, 1);
        assert.equal(results.filter(result => result.stdout.trim() === 'limited').length, 3);
        const count = child(`
            console.log(require('./src/database/init').db.prepare("SELECT COUNT(*) AS count FROM escrow_transactions WHERE guild_id='cap-race'").get().count);
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(count.status, 0, count.stderr);
        assert.equal(Number(count.stdout.trim()), 10);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('creating an offer frees expired pending slots without expiring accepted or paid deals', () => {
    const buyer = user();
    const seller = user();
    const guildId = 'cap-expiry-integrated-guild';
    const pending = Array.from({ length: 10 }, () => fixture(guildId, buyer, seller).deal);
    const paid = pending.pop();
    escrows.acceptEscrow(paid.id, 'old-paid-thread', seller.discord_id);
    escrows.markAsFunded(paid.id, buyer.discord_id);
    const old = new Date(Date.now() - policy.PENDING_OFFER_TTL_MS - 1000).toISOString();
    for (const deal of [...pending, paid]) db.prepare('UPDATE escrow_transactions SET created_at = ? WHERE id = ?').run(old, deal.id);
    const replacement = fixture(guildId, buyer, seller).deal;
    assert.equal(replacement.status, 'pending');
    assert.equal(escrows.getEscrowById(paid.id).status, 'funded');
    for (const deal of pending) {
        assert.equal(escrows.getEscrowById(deal.id).status, 'cancelled');
        assert.equal(escrows.getEscrowEvents(deal.id).filter(event => event.event_type === 'offer_expired').length, 1);
    }
    assert.equal(policy.assertActiveDealLimit(guildId, buyer.id), 2);
});
