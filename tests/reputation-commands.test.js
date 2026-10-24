process.env.DATABASE_PATH = ':memory:';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { getGuildReputation, setGuildRankOverride } = require('../src/database/reputationRepository');
const { setRankRole } = require('../src/database/guildSettingsRepository');
const repo = require('../src/database/escrowRepository');
const profileCommand = require('../src/commands/general/profile');
const rankCommand = require('../src/commands/general/set-rank');
const reviewCommand = require('../src/commands/general/review-flag');
const { syncMemberRankRole } = require('../src/utils/roleSync');
const { completionRewardText } = require('../src/interactions/helpers');
const receipt = require('../src/interactions/buttons/confirmReceipt');
const resolveComplete = require('../src/interactions/buttons/resolveComplete');

let sequence = 0;
const id = () => String(900000000000000000n + BigInt(++sequence));
const permissions = (...flags) => new PermissionsBitField(flags);
function user() {
    return { id: id(), tag: `Trader${sequence}`, bot: false, createdAt: new Date('2020-01-01'),
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
}
function fixture(target = user(), guildId = id()) {
    const calls = { replies: [], edits: [], added: [], removed: [], sent: [] };
    const bot = { id: id(), permissions: permissions(PermissionFlagsBits.ManageRoles), roles: { highest: { position: 100 } } };
    const guild = { id: guildId, name: `Server ${guildId}`, roles: { cache: new Map() }, members: { me: bot } };
    const member = { user: target, guild, manageable: true, joinedTimestamp: new Date('2021-01-01').getTime(),
        permissions: permissions(), roles: {
            cache: new Map(),
            add: async roleId => { calls.added.push(roleId); member.roles.cache.set(roleId, guild.roles.cache.get(roleId)); },
            remove: async roleId => { calls.removed.push(roleId); member.roles.cache.delete(roleId); },
        } };
    guild.members.fetch = async userId => userId === target.id ? member : null;
    function interaction(choice = 'gold', overrides = {}) {
        return {
            user: { ...user(), tag: 'Admin' }, guildId, guild, member,
            memberPermissions: permissions(PermissionFlagsBits.Administrator),
            options: { getUser: () => target, getString: () => choice },
            reply: async payload => { calls.replies.push(payload); },
            editReply: async payload => { calls.edits.push(payload); },
            deferReply: async () => {},
            ...overrides,
        };
    }
    function role(rank, dangerous = false) {
        const value = { id: id(), managed: false, editable: true, position: 2,
            permissions: dangerous ? permissions(PermissionFlagsBits.ManageRoles) : permissions() };
        guild.roles.cache.set(value.id, value);
        setRankRole(guildId, rank, value.id);
        return value;
    }
    return { calls, guild, member, target, guildId, interaction, role };
}
function stagedDeal(guildId, buyer, seller, targetStatus = 'delivered', details = {}) {
    const value = repo.createEscrow({ guildId, buyerId: getOrCreateUser(buyer).id, sellerId: getOrCreateUser(seller).id,
        itemDescription: 'A server trade', amount: 25, currency: 'USD', ...details });
    repo.acceptEscrow(value.id, id(), seller.id);
    repo.markAsFunded(value.id, buyer.id);
    if (targetStatus === 'disputed') repo.markAsDisputed(value.id, 'The delivered item does not match the agreed trade.', buyer.id);
    else repo.markAsDelivered(value.id, seller.id);
    return repo.getEscrowById(value.id);
}
function completeDeal(guildId, buyer, seller) {
    const value = stagedDeal(guildId, buyer, seller);
    assert.equal(repo.completeEscrow(value.id, value.buyer_id, value.seller_id, buyer.id), true);
    return value;
}
function fieldMap(embed) {
    return Object.fromEntries(embed.toJSON().fields.map(field => [field.name, field.value]));
}
function legacyFlagAndScore(target) {
    const identity = getOrCreateUser(target);
    db.prepare('UPDATE users SET trust_score = 999, successful_deals = 99, failed_deals = 7, is_scammer = 1, scam_flag_count = 4 WHERE id = ?').run(identity.id);
    return identity;
}

beforeEach(() => {
    db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;');
});
after(() => db.close());

test('/profile ignores legacy global scores, counts and scam flags', async () => {
    const f = fixture();
    legacyFlagAndScore(f.target);
    await profileCommand.execute(f.interaction());
    const embed = f.calls.edits[0].embeds[0];
    const fields = fieldMap(embed);
    assert.equal(fields['Earned Trust Points'], '0');
    assert.equal(fields['Active Rank Score'], '0');
    assert.match(fields.Rank, /Bronze/);
    assert.equal(fields['Successful Deals'], '0');
    assert.equal(fields['Failed Deals'], '0');
    assert.equal(fields['Recorded Flag Decisions'], '0');
    assert.equal(fields['Unique Trading Partners'], '0');
    assert.equal(fields['Trust Status'], 'No active scam flag');
    assert.match(embed.toJSON().description, /only.*Other servers have separate records/);
    assert.doesNotMatch(JSON.stringify(embed.toJSON()), /Cross-server activity record/);
});

test('/profile separates earned points, an audited admin override and each server\'s partner history', async () => {
    const trader = user();
    const a = fixture(trader);
    const b = fixture(trader);
    completeDeal(a.guildId, trader, user());
    const identity = getOrCreateUser(trader);
    setGuildRankOverride(a.guildId, identity.id, 200, user().id);
    await profileCommand.execute(a.interaction());
    await profileCommand.execute(b.interaction());
    const local = fieldMap(a.calls.edits[0].embeds[0]);
    const foreign = fieldMap(b.calls.edits[0].embeds[0]);
    assert.equal(local['Earned Trust Points'], '5');
    assert.equal(local['Active Rank Score'], '200');
    assert.match(local['Admin Rank Override'], /200 points.*manual override/);
    assert.match(local.Rank, /Diamond/);
    assert.equal(local['Successful Deals'], '1');
    assert.equal(local['Unique Trading Partners'], '1');
    assert.equal(foreign['Earned Trust Points'], '0');
    assert.equal(foreign['Active Rank Score'], '0');
    assert.equal(foreign['Successful Deals'], '0');
    assert.equal(foreign['Unique Trading Partners'], '0');
});

test('/set-rank preserves earned points and other servers, and reset returns to earned points', async () => {
    const trader = user();
    const f = fixture(trader);
    completeDeal(f.guildId, trader, user());
    const identity = legacyFlagAndScore(trader);
    const otherGuild = id();
    setGuildRankOverride(otherGuild, identity.id, 20, user().id);
    const set = f.interaction('diamond');
    await rankCommand.execute(set);
    let reputation = getGuildReputation(f.guildId, identity.id);
    assert.equal(reputation.earned_points, 5);
    assert.equal(reputation.trust_score, 200);
    assert.equal(reputation.rank_override_points, 200);
    assert.equal(reputation.successful_deals, 1);
    assert.equal(getGuildReputation(otherGuild, identity.id).trust_score, 20);
    assert.equal(getOrCreateUser(trader).trust_score, 999);
    let audit = db.prepare('SELECT * FROM guild_rank_override_audit WHERE guild_id = ? AND user_id = ? ORDER BY id').all(f.guildId, identity.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_discord_id, set.user.id);
    assert.equal(audit[0].new_override_points, 200);
    assert.match(f.calls.edits[0].content, /earned points were preserved/);
    const reset = f.interaction('earned');
    await rankCommand.execute(reset);
    reputation = getGuildReputation(f.guildId, identity.id);
    assert.equal(reputation.rank_override_points, null);
    assert.equal(reputation.earned_points, 5);
    assert.equal(reputation.trust_score, 5);
    audit = db.prepare('SELECT * FROM guild_rank_override_audit WHERE guild_id = ? AND user_id = ? ORDER BY id').all(f.guildId, identity.id);
    assert.equal(audit.length, 2);
    assert.equal(audit[1].old_override_points, 200);
    assert.equal(audit[1].new_override_points, null);
    assert.equal(audit[1].actor_discord_id, reset.user.id);
    assert.match(f.calls.edits.at(-1).content, /override.*cleared.*earned points/);
});

test('/set-rank checks current membership before creating identity, profile, or audit rows', async () => {
    const f = fixture();
    f.guild.members.fetch = async () => null;
    await rankCommand.execute(f.interaction('gold'));
    assert.match(f.calls.edits[0].content, /must currently belong.*No rank changes/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE discord_id = ?').get(f.target.id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guild_rank_override_audit').get().count, 0);
});

test('/set-rank rejects a non-administrator before fetching or updating a member', async () => {
    const f = fixture();
    let fetches = 0;
    f.guild.members.fetch = async () => { fetches++; return f.member; };
    await rankCommand.execute(f.interaction('diamond', { memberPermissions: permissions() }));
    assert.equal(fetches, 0);
    assert.match(f.calls.replies[0].content, /Only server administrators/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guild_rank_override_audit').get().count, 0);
});

test('role synchronization ignores passed global scores and applies only current-server reputation', async () => {
    const trader = user();
    const a = fixture(trader);
    const b = fixture(trader);
    const identity = legacyFlagAndScore(trader);
    const aBronze = a.role('bronze');
    const aDiamond = a.role('diamond');
    const bBronze = b.role('bronze');
    const bDiamond = b.role('diamond');
    a.member.roles.cache.set(aDiamond.id, aDiamond);
    assert.equal(await syncMemberRankRole(a.member, 999), true);
    assert.deepEqual(a.calls.removed, [aDiamond.id]);
    assert.deepEqual(a.calls.added, [aBronze.id]);
    setGuildRankOverride(a.guildId, identity.id, 200, user().id);
    assert.equal(await syncMemberRankRole(a.member, 0), true);
    assert.ok(a.member.roles.cache.has(aDiamond.id));
    b.member.roles.cache.set(bDiamond.id, bDiamond);
    assert.equal(await syncMemberRankRole(b.member, 200), true);
    assert.deepEqual(b.calls.removed, [bDiamond.id]);
    assert.deepEqual(b.calls.added, [bBronze.id]);
});

test('a local scam flag removes cosmetic ranks only in that server and preserves unrelated roles', async () => {
    const trader = user();
    const a = fixture(trader);
    const b = fixture(trader);
    const aBronze = a.role('bronze');
    const bBronze = b.role('bronze');
    const unrelated = { id: id() };
    a.member.roles.cache.set(aBronze.id, aBronze);
    a.member.roles.cache.set(unrelated.id, unrelated);
    const dispute = stagedDeal(a.guildId, user(), trader, 'disputed');
    repo.flagScammerAndCancel(dispute.id, getOrCreateUser(trader).id, user().id);
    assert.equal(await syncMemberRankRole(a.member), true);
    assert.deepEqual(a.calls.removed, [aBronze.id]);
    assert.equal(a.calls.added.length, 0);
    assert.ok(a.member.roles.cache.has(unrelated.id));
    assert.equal(await syncMemberRankRole(b.member), true);
    assert.deepEqual(b.calls.added, [bBronze.id]);
});

test('rank sync never assigns a dangerous local override role', async () => {
    const f = fixture();
    const identity = getOrCreateUser(f.target);
    setGuildRankOverride(f.guildId, identity.id, 200, user().id);
    f.role('diamond', true);
    assert.equal(await syncMemberRankRole(f.member), false);
    assert.equal(f.calls.added.length, 0);
    assert.equal(f.calls.removed.length, 0);
});

function flagInGuild(guildId, target) {
    const escrow = stagedDeal(guildId, user(), target, 'disputed');
    assert.equal(repo.flagScammerAndCancel(escrow.id, getOrCreateUser(target).id, user().id), true);
    return escrow;
}

function reviewInteraction(f, reason = 'The evidence was reviewed and the original flag was incorrect.', overrides = {}) {
    return f.interaction('unused', {
        options: { getUser: () => f.target, getString: () => reason },
        ...overrides,
    });
}

test('/review-flag requires Administrator and rejects short reasons without changing a local flag', async () => {
    const f = fixture();
    flagInGuild(f.guildId, f.target);
    const identity = getOrCreateUser(f.target);
    await reviewCommand.execute(reviewInteraction(f, undefined, { memberPermissions: permissions() }));
    assert.match(f.calls.replies[0].content, /Only server administrators/);
    await reviewCommand.execute(reviewInteraction(f, 'short'));
    assert.match(f.calls.replies.at(-1).content, /10 to 1,000/);
    assert.equal(getGuildReputation(f.guildId, identity.id).is_scammer, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guild_flag_review_audit').get().count, 0);
});

test('/review-flag clears only this server, audits the reason, preserves history, and restores a safe local rank', async () => {
    const target = user();
    const a = fixture(target);
    const b = fixture(target);
    const aBronze = a.role('bronze');
    flagInGuild(a.guildId, target);
    flagInGuild(b.guildId, target);
    legacyFlagAndScore(target);
    const identity = getOrCreateUser(target);
    const reason = 'The complete transcript shows that this flag was assigned to the wrong party.';
    const input = reviewInteraction(a, reason);
    await reviewCommand.execute(input);
    const local = getGuildReputation(a.guildId, identity.id);
    assert.equal(local.is_scammer, 0);
    assert.equal(local.scam_flag_count, 1);
    assert.equal(local.failed_deals, 1);
    assert.equal(getGuildReputation(b.guildId, identity.id).is_scammer, 1);
    assert.equal(getOrCreateUser(target).is_scammer, 1);
    const audit = db.prepare('SELECT * FROM guild_flag_review_audit WHERE guild_id = ? AND user_id = ?').get(a.guildId, identity.id);
    assert.equal(audit.reason, reason);
    assert.equal(audit.actor_discord_id, input.user.id);
    assert.equal(audit.old_is_scammer, 1);
    assert.equal(audit.new_is_scammer, 0);
    assert.deepEqual(a.calls.added, [aBronze.id]);
    assert.match(a.calls.edits[0].content, /in this server only/);
    assert.match(a.calls.edits[0].content, /Historical flag decisions and review records are preserved/);
    assert.deepEqual(a.calls.edits[0].allowedMentions, { parse: [] });
    await profileCommand.execute(a.interaction());
    const fields = fieldMap(a.calls.edits.at(-1).embeds[0]);
    assert.equal(fields['Trust Status'], 'No active scam flag');
    assert.equal(fields['Recorded Flag Decisions'], '1');
});

test('/review-flag is honest when no local flag exists and does not create review audit entries', async () => {
    const f = fixture();
    await reviewCommand.execute(reviewInteraction(f));
    assert.match(f.calls.edits[0].content, /no active scam flag.*No flag review change/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guild_flag_review_audit').get().count, 0);
    assert.equal(f.calls.added.length, 0);
});

test('/review-flag can clear a departed user\'s local flag and reports that no roles were changed', async () => {
    const f = fixture();
    flagInGuild(f.guildId, f.target);
    f.guild.members.fetch = async () => null;
    await reviewCommand.execute(reviewInteraction(f));
    assert.equal(getGuildReputation(f.guildId, getOrCreateUser(f.target).id).is_scammer, 0);
    assert.match(f.calls.edits[0].content, /not currently in this server.*no Discord roles were changed/);
    assert.equal(f.calls.added.length, 0);
});

function completionInteraction(f, escrow, actor = f.target, moderator = false) {
    const member = { ...f.member, user: actor, permissions: moderator ? permissions(PermissionFlagsBits.Administrator) : permissions() };
    return {
        guildId: f.guildId, guild: f.guild, user: actor, member, channelId: escrow.channel_id,
        customId: `${moderator ? 'resolve_complete_' : 'confirm_receipt_'}${escrow.id}`,
        message: { embeds: [new EmbedBuilder().setTitle('Confirmation').toJSON()] },
        channel: { send: async payload => { f.calls.sent.push(payload); } },
        deferred: false, replied: false,
        deferUpdate: async function () { this.deferred = true; },
        editReply: async payload => { f.calls.edits.push(payload); },
        reply: async payload => { f.calls.replies.push(payload); },
        followUp: async payload => { f.calls.replies.push(payload); },
    };
}

test('receipt and moderator completion messages use the exact reward ledger and preserve stack payment labels', async () => {
    const buyer = user();
    const seller = user();
    const f = fixture(buyer);
    // Role sync has no configuration here; both members can be fetched without network.
    f.guild.members.fetch = async userId => ({ ...f.member, user: userId === buyer.id ? buyer : seller });
    const first = stagedDeal(f.guildId, buyer, seller, 'delivered', { amount: 2, currency: 'Redblocks', paymentUnit: 'stacks' });
    await receipt.execute(completionInteraction(f, first));
    assert.equal(repo.getEscrowReward(first.id).awarded_points, 5);
    let fields = fieldMap(f.calls.sent[0].embeds[0]);
    assert.match(fields['Server Reputation'], /earned 5 trust points and one successful deal in this server/);
    assert.match(fields['Agreed Payment'], /2 stacks of Redblocks \(128 blocks\)/);
    const second = stagedDeal(f.guildId, buyer, seller, 'disputed', { amount: 1, currency: 'Golds', paymentUnit: 'stacks' });
    await resolveComplete.execute(completionInteraction(f, second, user(), true));
    assert.equal(repo.getEscrowReward(second.id).awarded_points, 0);
    fields = fieldMap(f.calls.edits.at(-1).embeds[0]);
    assert.match(fields['Server Reputation'], /No trust points were added/);
    assert.match(fields['Server Reputation'], /once per 24 hours in this server/);
    assert.match(fields['Agreed Payment'], /1 stack of Golds \(64 items\)/);
    assert.doesNotMatch(fields['Server Reputation'], /earned 5/);
    assert.match(completionRewardText(id()), /view the reputation recorded in this server/);
});
