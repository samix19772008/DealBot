const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.DATABASE_PATH = ':memory:';
const { db, initDatabase } = require('../src/database/init');
const users = require('../src/database/userRepository');
const settings = require('../src/database/guildSettingsRepository');
const escrows = require('../src/database/escrowRepository');
let sequence = 0;
function user(name = 'Trader') {
    sequence += 1;
    return users.getOrCreateUser({ id: `user-${sequence}`, tag: `${name}-${sequence}`, createdAt: new Date('2020-01-01') });
}
function fixture(guildId = 'guild-a') {
    const buyer = user('Buyer');
    const seller = user('Seller');
    const deal = escrows.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'A digital item', amount: 12.25, currency: 'USD' });
    return { buyer, seller, deal };
}
function freshUser(row) { return db.prepare('SELECT * FROM users WHERE id = ?').get(row.id); }

test('fresh initialization is repeatable and creates every supported server setting', () => {
    initDatabase();
    initDatabase();
    settings.setModeratorRole('settings-guild', 'mod-role');
    settings.setHubChannel('settings-guild', 'hub-channel');
    settings.setLanguage('settings-guild', 'en');
    for (const rank of ['bronze', 'silver', 'gold', 'platinum', 'diamond']) {
        settings.setRankRole('settings-guild', rank, `${rank}-role`);
    }
    const result = settings.getGuildSettings('settings-guild');
    assert.equal(result.hub_channel_id, 'hub-channel');
    assert.equal(result.diamond_role_id, 'diamond-role');
    assert.equal(result.language, 'en');
    assert.throws(() => settings.setRankRole('settings-guild', 'bad; DROP TABLE users', 'role'), /Unknown trust rank/);
    assert.throws(() => settings.setLanguage('settings-guild', 'ar'), /English only/);
    assert.equal(settings.getGuildSettings(null), undefined);
});

test('legacy migration preserves settings, profiles and deals across two initializations', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-migration-'));
    const filename = path.join(directory, 'legacy.sqlite');
    const Database = require('better-sqlite3');
    const legacy = new Database(filename);
    const schema = fs.readFileSync(path.join(__dirname, '../src/database/schema.sql'), 'utf8')
        .replace(/^.*buyer_close_approved.*\r?\n/gm, '')
        .replace(/^.*seller_close_approved.*\r?\n/gm, '')
        .replace(/^.*payment_unit.*\r?\n/gm, '')
        .replace(/CREATE TABLE IF NOT EXISTS escrow_thread_closures[\s\S]*$/, '')
        .replace(/^.*(?:hub_channel_id|language\s+TEXT|(?:bronze|silver|gold|platinum|diamond)_role_id).*\r?\n/gm, '');
    legacy.exec(schema);
    legacy.exec("ALTER TABLE guild_settings ADD COLUMN language TEXT DEFAULT 'ar'");
    legacy.prepare('INSERT INTO guild_settings (guild_id, moderator_role_id, language) VALUES (?, ?, ?)')
        .run('old-guild', 'old-mod', 'ar');
    legacy.prepare('INSERT INTO users (discord_id, username, account_created_at, trust_score) VALUES (?, ?, ?, ?)')
        .run('legacy-buyer', 'Buyer', '2020-01-01', 15);
    legacy.prepare('INSERT INTO users (discord_id, username, account_created_at) VALUES (?, ?, ?)')
        .run('legacy-seller', 'Seller', '2020-01-01');
    legacy.prepare(`INSERT INTO escrow_transactions
        (transaction_uuid, guild_id, buyer_id, seller_id, item_description, amount, currency)
        VALUES ('ESC-LEGACY', 'old-guild', 1, 2, 'Original item', 10, 'USD')`).run();
    legacy.close();
    const script = `
        const assert = require('node:assert/strict');
        const { db, initDatabase } = require('./src/database/init');
        initDatabase(); initDatabase();
        const settings = require('./src/database/guildSettingsRepository');
        settings.setHubChannel('old-guild', 'new-hub');
        settings.setRankRole('old-guild', 'silver', 'silver-role');
        const saved = settings.getGuildSettings('old-guild');
        assert.equal(saved.moderator_role_id, 'old-mod');
        assert.equal(saved.language, 'en');
        assert.equal(saved.hub_channel_id, 'new-hub');
        const deal = require('./src/database/escrowRepository').getEscrowById('esc-legacy');
        assert.equal(deal.item_description, 'Original item');
        assert.equal(deal.buyer_close_approved, 0);
        assert.equal(deal.amount, 10);
        assert.equal(deal.currency, 'USD');
        assert.equal(deal.payment_unit, null);
        assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'escrow_thread_closures'").get());
        assert.equal(db.prepare('SELECT trust_score FROM users WHERE id = 1').get().trust_score, 15);
        db.close();
    `;
    try {
        const result = spawnSync(process.execPath, ['-e', script], {
            cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: filename }, encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('normal lifecycle rewards stored participants exactly once and records audit history', () => {
    const { buyer, seller, deal } = fixture();
    const outsider = user('Outsider');
    assert.match(deal.transaction_uuid, /^ESC-[A-F\d]{8}-[A-F\d]{4}-[A-F\d]{4}-[A-F\d]{4}-[A-F\d]{12}$/);
    assert.equal(escrows.getEscrowById(deal.transaction_uuid.toLowerCase()).id, deal.id);
    assert.equal(escrows.markAsDelivered(deal.id), false);
    assert.equal(escrows.completeEscrow(deal.id, buyer.id, seller.id), false);
    assert.equal(escrows.acceptEscrow(deal.id, 'thread-1', seller.discord_id), true);
    assert.equal(escrows.acceptEscrow(deal.id, 'thread-duplicate', seller.discord_id), false);
    assert.equal(escrows.markAsFunded(deal.id, buyer.discord_id), true);
    assert.equal(escrows.markAsFunded(deal.id, buyer.discord_id), false);
    assert.equal(escrows.markAsDelivered(deal.id, seller.discord_id), true);
    // Supplying unrelated participant IDs must never redirect a reward.
    assert.equal(escrows.completeEscrow(deal.id, outsider.id, outsider.id, buyer.discord_id), true);
    assert.equal(escrows.completeEscrow(deal.id, buyer.id, seller.id, buyer.discord_id), false);
    assert.equal(freshUser(buyer).successful_deals, 1);
    assert.equal(freshUser(buyer).trust_score, 5);
    assert.equal(freshUser(seller).successful_deals, 1);
    assert.equal(freshUser(seller).trust_score, 5);
    assert.equal(freshUser(outsider).trust_score, 0);
    assert.equal(escrows.getEscrowByChannelId('thread-1').id, deal.id);
    const history = escrows.getEscrowEvents(deal.id);
    assert.deepEqual(history.map(event => event.event_type),
        ['completed', 'delivery_confirmed', 'payment_confirmed', 'accepted', 'created']);
    assert.equal(history[0].actor_discord_id, buyer.discord_id);
    assert.ok(escrows.getEscrowById(deal.id).completed_at);
});

test('stale cancellation and dispute controls cannot overwrite a completed deal', () => {
    const { buyer, seller, deal } = fixture();
    assert.equal(escrows.cancelEscrow(deal.id, { actorId: buyer.discord_id, reason: 'Changed my mind' }), true);
    assert.equal(escrows.cancelEscrow(deal.id), false);
    assert.equal(escrows.markAsFunded(deal.id), false);
    assert.equal(escrows.markAsDisputed(deal.id, 'Old button', buyer.discord_id), false);
    assert.equal(escrows.flagScammerAndCancel(deal.id, seller.id, 'mod'), false);
    assert.equal(freshUser(seller).is_scammer, 0);
    const second = fixture();
    escrows.acceptEscrow(second.deal.id, 'thread-2');
    assert.equal(escrows.cancelEscrow(second.deal.id), false);
    assert.equal(escrows.markAsDisputed(second.deal.id, 'Payment disagreement', second.buyer.discord_id), true);
    assert.equal(escrows.markAsFunded(second.deal.id), false);
    assert.equal(escrows.completeEscrow(second.deal.id, second.buyer.id, second.seller.id), false);
    assert.equal(escrows.completeEscrow(second.deal.id, second.buyer.id, second.seller.id, 'moderator', 'disputed'), true);
    assert.equal(escrows.cancelEscrow(second.deal.id, { expectedStatus: 'disputed' }), false);
    assert.equal(escrows.getEscrowById(second.deal.id).status, 'completed');
});

test('scam resolution is atomic, only targets participants, and cannot be replayed', () => {
    const { buyer, seller, deal } = fixture();
    const outsider = user();
    escrows.acceptEscrow(deal.id, 'scam-thread');
    escrows.markAsDisputed(deal.id, 'Seller did not deliver', buyer.discord_id);
    assert.equal(escrows.flagScammerAndCancel(deal.id, outsider.id, 'mod'), false);
    assert.equal(escrows.getEscrowById(deal.id).status, 'disputed');
    assert.equal(escrows.flagScammerAndCancel(deal.id, seller.id, 'mod'), true);
    assert.equal(escrows.flagScammerAndCancel(deal.id, buyer.id, 'mod'), false);
    assert.equal(escrows.getEscrowById(deal.id).status, 'cancelled');
    assert.equal(freshUser(seller).is_scammer, 1);
    assert.equal(freshUser(seller).scam_flag_count, 1);
    assert.equal(freshUser(seller).failed_deals, 1);
    assert.equal(freshUser(buyer).is_scammer, 0);
    assert.equal(escrows.getEscrowEvents(deal.id)[0].event_type, 'scammer_flagged');
    assert.throws(() => escrows.createEscrow({ guildId: 'guild-a', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Another item', amount: 5, currency: 'USD' }), /flagged as scammers/);
});

test('a database failure rolls completion and all trust rewards back together', () => {
    const { buyer, seller, deal } = fixture();
    escrows.acceptEscrow(deal.id, 'rollback-thread');
    escrows.markAsFunded(deal.id);
    escrows.markAsDelivered(deal.id);
    db.exec(`CREATE TEMP TRIGGER fail_reward BEFORE UPDATE OF successful_deals ON users
        WHEN NEW.id = ${seller.id} BEGIN SELECT RAISE(ABORT, 'Simulated reward failure'); END;`);
    try {
        assert.throws(() => escrows.completeEscrow(deal.id, buyer.id, seller.id), /Simulated reward failure/);
        assert.equal(escrows.getEscrowById(deal.id).status, 'delivered');
        assert.equal(freshUser(buyer).trust_score, 0);
        assert.equal(freshUser(seller).trust_score, 0);
        assert.equal(escrows.getEscrowEvents(deal.id)[0].event_type, 'delivery_confirmed');
    } finally {
        db.exec('DROP TRIGGER fail_reward');
    }
});

test('new deal validation rejects unsafe amounts and malformed participants', () => {
    const buyer = user();
    const seller = user();
    const defaults = { guildId: 'guild-a', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Item', amount: 5, currency: 'USD' };
    for (const amount of [0, -1, NaN, Infinity, 0.001, 10000000000, '12.25', 0.1 + 0.2]) {
        assert.throws(() => escrows.createEscrow({ ...defaults, amount }), /amount/);
    }
    assert.throws(() => escrows.createEscrow({ ...defaults, sellerId: buyer.id }), /different participants/);
    assert.throws(() => escrows.createEscrow({ ...defaults, sellerId: 99999999 }), /trust profile/);
    assert.throws(() => escrows.createEscrow({ ...defaults, itemDescription: ' ' }), /description/);
    assert.throws(() => escrows.createEscrow({ ...defaults, itemDescription: 'x'.repeat(1001) }), /description/);
    assert.throws(() => escrows.createEscrow({ ...defaults, currency: 'x'.repeat(25) }), /currency/);
    assert.throws(() => escrows.createEscrow({ ...defaults, currency: 'USD\n' }), /currency/);
    assert.equal(escrows.createEscrow({ ...defaults, amount: 0.3 }).amount, 0.3);
});

test('listings are scoped to both the participant and server and honor status filters', () => {
    const { buyer, seller, deal } = fixture('private-guild');
    const other = user();
    const closed = escrows.createEscrow({ guildId: 'private-guild', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Cancelled item', amount: 5, currency: 'USD' });
    escrows.cancelEscrow(closed.id);
    escrows.createEscrow({ guildId: 'other-guild', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Other server item', amount: 5, currency: 'USD' });
    assert.deepEqual(escrows.listEscrowsForUser('private-guild', buyer.discord_id).map(row => row.id), [deal.id]);
    assert.equal(escrows.listEscrowsForUser('private-guild', buyer.discord_id, { status: 'all' }).length, 2);
    assert.deepEqual(escrows.listEscrowsForUser('private-guild', seller.discord_id, { status: 'cancelled' }).map(row => row.id), [closed.id]);
    assert.deepEqual(escrows.listEscrowsForUser('private-guild', other.discord_id), []);
    assert.deepEqual(escrows.listEscrowsForUser('private-guild', buyer.discord_id, { status: 'bad filter' }), []);
    assert.deepEqual(escrows.listEscrowsForUser('private-guild', buyer.discord_id, { offset: 10 }), []);
});

test('close approvals are allowed only on resolved deals and are recorded once', () => {
    const { buyer, seller, deal } = fixture();
    assert.equal(escrows.approveBuyerClose(deal.id), false);
    escrows.cancelEscrow(deal.id);
    assert.equal(escrows.approveBuyerClose(deal.id, buyer.discord_id), true);
    assert.equal(escrows.approveBuyerClose(deal.id, buyer.discord_id), false);
    assert.equal(escrows.approveSellerClose(deal.id, seller.discord_id), true);
    const latest = escrows.getEscrowById(deal.id);
    assert.equal(latest.buyer_close_approved, 1);
    assert.equal(latest.seller_close_approved, 1);
});


test('payment units preserve nominal stack counts and canonical market names', () => {
    const buyer = user();
    const seller = user();
    const defaults = { guildId: 'market-guild', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Game blocks', amount: 20 };
    for (const currency of ['Golds', 'Redblocks', 'Sky 1 Notchs']) {
        const deal = escrows.createEscrow({ ...defaults, currency, paymentUnit: 'stacks' });
        assert.equal(deal.amount, 20, 'Do not convert nominal stacks to individual items in storage');
        assert.equal(deal.currency, currency);
        assert.equal(deal.payment_unit, 'stacks');
        assert.equal(escrows.getEscrowById(deal.id).payment_unit, 'stacks');
    }
    const money = escrows.createEscrow({ ...defaults, amount: 10.25, currency: 'USD', paymentUnit: 'each' });
    assert.equal(money.amount, 10.25);
    assert.equal(money.payment_unit, 'each');
    const legacy = escrows.createEscrow({ ...defaults, amount: 10.25, currency: 'Legacy coins' });
    assert.equal(legacy.currency, 'Legacy coins');
    assert.equal(legacy.payment_unit, null);
});

test('market-unit validation refuses unsupported units, money stacks, and fractional game quantities', () => {
    const buyer = user();
    const seller = user();
    const defaults = { guildId: 'market-guild', buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Market item', amount: 20, currency: 'Golds', paymentUnit: 'each' };
    assert.throws(() => escrows.createEscrow({ ...defaults, paymentUnit: 'boxes' }), /unit/);
    assert.throws(() => escrows.createEscrow({ ...defaults, currency: 'USD', paymentUnit: 'stacks' }));
    assert.throws(() => escrows.createEscrow({ ...defaults, amount: 2.5 }));
    assert.throws(() => escrows.createEscrow({ ...defaults, amount: 2.5, paymentUnit: 'stacks' }));
    assert.throws(() => escrows.createEscrow({ ...defaults, amount: 9999999999, paymentUnit: 'stacks' }));
    assert.throws(() => escrows.createEscrow({ ...defaults, currency: 'Unsupported token' }));
    const legacy = escrows.createEscrow({ ...defaults, amount: 2.5, currency: 'Old game coins', paymentUnit: null });
    assert.equal(legacy.amount, 2.5);
    assert.equal(legacy.payment_unit, null);
});

test.after(() => db.close());
