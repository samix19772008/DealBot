process.env.DATABASE_PATH = ':memory:';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, initDatabase } = require('../src/database/init');
const { getOrCreateUser, flagAsScammer, setTrustScore } = require('../src/database/userRepository');
const repo = require('../src/database/escrowRepository');
const reputations = require('../src/database/reputationRepository');
let sequence = 0;
function user() { return getOrCreateUser({ id: `trader-${++sequence}`, tag: `Trader${sequence}`, createdAt: new Date('2020-01-01') }); }
function deal(guildId, buyer, seller) {
    return repo.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id, itemDescription: 'An item', amount: 10, currency: 'USD' });
}
function complete(row) {
    assert.equal(repo.acceptEscrow(row.id, `thread-${row.id}`, row.seller_discord_id), true);
    assert.equal(repo.markAsFunded(row.id, row.buyer_discord_id), true);
    assert.equal(repo.markAsDelivered(row.id, row.seller_discord_id), true);
    return repo.completeEscrow(row.id, row.buyer_id, row.seller_id, row.buyer_discord_id);
}
function flag(row, userId) {
    assert.equal(repo.acceptEscrow(row.id, `thread-${row.id}`, row.seller_discord_id), true);
    assert.equal(repo.markAsDisputed(row.id, 'The delivery was not received.', row.buyer_discord_id), true);
    assert.equal(repo.flagScammerAndCancel(row.id, userId, 'staff'), true);
}
const rep = (guild, member) => reputations.getGuildReputation(guild, member.id);

test('server-local completion counts and points never mutate legacy global identity statistics', () => {
    const buyer = user(); const seller = user();
    db.prepare('UPDATE users SET trust_score = 900, successful_deals = 50, is_scammer = 1 WHERE id = ?').run(buyer.id);
    const row = deal('local-points', buyer, seller);
    assert.equal(complete(row), true);
    assert.equal(rep('local-points', buyer).earned_points, 5);
    assert.equal(rep('local-points', buyer).successful_deals, 1);
    assert.equal(rep('other-server', buyer).earned_points, 0);
    assert.equal(rep('other-server', buyer).is_scammer, 0);
    const legacy = db.prepare('SELECT * FROM users WHERE id = ?').get(buyer.id);
    assert.equal(legacy.trust_score, 900);
    assert.equal(legacy.successful_deals, 50);
    assert.equal(legacy.is_scammer, 1);
});

test('the same pair earns points once per rolling 24 hours regardless of buyer/seller direction', () => {
    const buyer = user(); const seller = user();
    const first = deal('pair-window', buyer, seller); complete(first);
    const repeat = deal('pair-window', seller, buyer); complete(repeat);
    assert.equal(repo.getEscrowReward(first.id).awarded_points, 5);
    assert.equal(repo.getEscrowReward(repeat.id).awarded_points, 0);
    assert.equal(rep('pair-window', buyer).earned_points, 5);
    assert.equal(rep('pair-window', buyer).successful_deals, 2);
    assert.equal(rep('pair-window', buyer).unique_partners, 1);
    assert.equal(repo.completeEscrow(repeat.id, repeat.buyer_id, repeat.seller_id), false);
    assert.equal(rep('pair-window', buyer).successful_deals, 2);
    db.prepare("UPDATE escrow_reward_ledger SET completed_at = datetime('now', '-24 hours', '-1 second') WHERE escrow_id = ?").run(first.id);
    const afterWindow = deal('pair-window', buyer, seller); complete(afterWindow);
    assert.equal(repo.getEscrowReward(afterWindow.id).awarded_points, 5);
    assert.equal(rep('pair-window', buyer).earned_points, 10);
    assert.equal(rep('pair-window', buyer).successful_deals, 3);
});

test('independent servers and distinct counterparties have independent earning windows', () => {
    const buyer = user(); const seller = user(); const otherSeller = user();
    complete(deal('pair-a', buyer, seller));
    complete(deal('pair-b', buyer, seller));
    complete(deal('pair-a', buyer, otherSeller));
    assert.equal(rep('pair-a', buyer).earned_points, 10);
    assert.equal(rep('pair-a', buyer).unique_partners, 2);
    assert.equal(rep('pair-b', buyer).earned_points, 5);
    assert.equal(rep('pair-b', buyer).unique_partners, 1);
});

test('rank overrides are local, audited, idempotent and separate from earned points and deal statistics', () => {
    const buyer = user(); const seller = user();
    complete(deal('manual-a', buyer, seller));
    assert.equal(reputations.setGuildRankOverride('manual-a', buyer.id, 200, 'staff-a'), true);
    assert.equal(reputations.setGuildRankOverride('manual-a', buyer.id, 200, 'staff-a'), false);
    const local = rep('manual-a', buyer);
    assert.equal(local.trust_score, 200);
    assert.equal(local.rank_override_points, 200);
    assert.equal(local.earned_points, 5);
    assert.equal(local.successful_deals, 1);
    assert.equal(rep('manual-b', buyer).trust_score, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guild_rank_override_audit WHERE guild_id = ? AND user_id = ?').get('manual-a', buyer.id).n, 1);
    assert.equal(reputations.clearGuildRankOverride('manual-a', buyer.id, 'staff-a'), true);
    assert.equal(reputations.clearGuildRankOverride('manual-a', buyer.id, 'staff-a'), false);
    assert.equal(rep('manual-a', buyer).trust_score, 5);
    const audit = db.prepare('SELECT * FROM guild_rank_override_audit WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get('manual-a', buyer.id);
    assert.equal(audit.old_override_points, 200);
    assert.equal(audit.new_override_points, null);
    assert.throws(() => reputations.setGuildRankOverride('manual-a', buyer.id, 200), /staff member/);
    assert.throws(() => setTrustScore(buyer.id, 999), /Global trust overrides are disabled/);
    assert.throws(() => flagAsScammer(buyer.id), /Global scam flags are disabled/);
});

test('local scam decisions block creation and pending acceptance only in their own server', () => {
    const buyer = user(); const seller = user();
    const pendingHere = deal('flag-a', buyer, seller);
    const pendingElsewhere = deal('flag-b', buyer, seller);
    flag(deal('flag-a', buyer, seller), seller.id);
    assert.equal(rep('flag-a', seller).is_scammer, 1);
    assert.equal(rep('flag-a', seller).scam_flag_count, 1);
    assert.equal(rep('flag-a', seller).failed_deals, 1);
    assert.equal(rep('flag-b', seller).is_scammer, 0);
    assert.equal(repo.acceptEscrow(pendingHere.id, 'denied-thread', seller.discord_id), false);
    assert.equal(repo.getEscrowById(pendingHere.id).status, 'pending');
    assert.equal(repo.acceptEscrow(pendingElsewhere.id, 'allowed-thread', seller.discord_id), true);
    assert.throws(() => deal('flag-a', buyer, seller), /flagged as scammers in this server/);
    assert.equal(deal('flag-b', buyer, seller).status, 'pending');
    assert.equal(db.prepare('SELECT is_scammer FROM users WHERE id = ?').get(seller.id).is_scammer, 0);
});

test('a reviewed flag is cleared locally without erasing history, points, or the other server flag', () => {
    const buyer = user(); const seller = user();
    complete(deal('appeal-a', buyer, seller));
    flag(deal('appeal-a', buyer, seller), seller.id);
    flag(deal('appeal-b', buyer, seller), seller.id);
    const before = rep('appeal-a', seller);
    assert.throws(() => reputations.clearGuildScamFlag('appeal-a', seller.id, 'staff', 'short'), /10 to 1,000/);
    assert.equal(reputations.clearGuildScamFlag('appeal-a', seller.id, 'staff', 'Evidence review shows that this was a mistaken flag.'), true);
    assert.equal(reputations.clearGuildScamFlag('appeal-a', seller.id, 'staff', 'Repeated review should not erase any history.'), false);
    initDatabase();
    const after = rep('appeal-a', seller);
    assert.equal(after.is_scammer, 0);
    assert.equal(after.scam_flag_count, before.scam_flag_count);
    assert.equal(after.failed_deals, before.failed_deals);
    assert.equal(after.earned_points, before.earned_points);
    assert.equal(after.successful_deals, before.successful_deals);
    assert.equal(rep('appeal-b', seller).is_scammer, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guild_flag_review_audit WHERE guild_id = ? AND user_id = ?').get('appeal-a', seller.id).n, 1);
    assert.equal(deal('appeal-a', buyer, seller).status, 'pending');
});

test('failure during local reward writes rolls back completion, ledger, audit, and both participant statistics', () => {
    const buyer = user(); const seller = user();
    const row = deal('rollback-local', buyer, seller);
    repo.acceptEscrow(row.id, 'rollback-thread'); repo.markAsFunded(row.id); repo.markAsDelivered(row.id);
    db.exec(`CREATE TEMP TRIGGER fail_local_reward BEFORE UPDATE OF earned_points ON guild_user_profiles
        WHEN NEW.guild_id = 'rollback-local' AND NEW.user_id = ${seller.id}
        BEGIN SELECT RAISE(ABORT, 'Simulated local reward failure'); END;`);
    try {
        assert.throws(() => repo.completeEscrow(row.id, buyer.id, seller.id), /Simulated local reward failure/);
        assert.equal(repo.getEscrowById(row.id).status, 'delivered');
        assert.equal(repo.getEscrowReward(row.id), undefined);
        assert.equal(rep('rollback-local', buyer).earned_points, 0);
        assert.equal(rep('rollback-local', seller).successful_deals, 0);
        assert.equal(repo.getEscrowEvents(row.id)[0].event_type, 'delivery_confirmed');
    } finally { db.exec('DROP TRIGGER fail_local_reward'); }
});

after(() => db.close());
