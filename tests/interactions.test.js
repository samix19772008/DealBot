const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_PATH = ':memory:';
const { EmbedBuilder, ChannelType } = require('discord.js');
const { db } = require('../src/database/init');
const repo = require('../src/database/escrowRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
const { getGuildReputation } = require('../src/database/reputationRepository');
const { setModeratorRole, setHubChannel, setRankRole } = require('../src/database/guildSettingsRepository');
const cancelModal = require('../src/interactions/modals/cancelReasonModal');
const payment = require('../src/interactions/buttons/confirmPayment');
const delivery = require('../src/interactions/buttons/confirmDelivery');
const receipt = require('../src/interactions/buttons/confirmReceipt');
const openDispute = require('../src/interactions/buttons/openDispute');
const disputeModal = require('../src/interactions/modals/disputeReasonModal');
const scammer = require('../src/interactions/buttons/scammerPick');
const resolveComplete = require('../src/interactions/buttons/resolveComplete');
const approveClose = require('../src/interactions/buttons/approveClose');
const accept = require('../src/interactions/buttons/acceptEscrow');
const offerModal = require('../src/interactions/modals/dealOfferModal');

const buyerDiscord = { id: '100000000000000001', tag: 'buyer', createdAt: new Date('2020-01-01'), bot: false };
const sellerDiscord = { id: '100000000000000002', tag: 'seller', createdAt: new Date('2020-01-01'), bot: false };
const moderatorDiscord = { id: '100000000000000003', tag: 'moderator', createdAt: new Date('2020-01-01'), bot: false };
const otherDiscord = { id: '100000000000000004', tag: 'outsider', createdAt: new Date('2020-01-01'), bot: false };
const guildId = '200000000000000001';
const channelId = '300000000000000001';

beforeEach(() => {
    db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;');
});
after(() => db.close());

function deal(status = 'pending') {
    const buyer = getOrCreateUser(buyerDiscord);
    const seller = getOrCreateUser(sellerDiscord);
    const escrow = repo.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id, itemDescription: 'Game item', amount: 25, currency: 'USD' });
    if (status !== 'pending') repo.acceptEscrow(escrow.id, channelId, sellerDiscord.id);
    if (['funded', 'delivered', 'completed', 'disputed'].includes(status)) repo.markAsFunded(escrow.id, buyerDiscord.id);
    if (['delivered', 'completed'].includes(status)) repo.markAsDelivered(escrow.id, sellerDiscord.id);
    if (status === 'completed') repo.completeEscrow(escrow.id, buyer.id, seller.id, buyerDiscord.id);
    if (status === 'disputed') repo.markAsDisputed(escrow.id, 'The agreed item was not received.', buyerDiscord.id);
    return repo.getEscrowById(escrow.id);
}

function interaction(customId, user = buyerDiscord, overrides = {}) {
    const calls = { reply: [], followUp: [], editReply: [], send: [], modals: [], locked: [], archived: [] };
    const members = new Map([buyerDiscord, sellerDiscord, moderatorDiscord, otherDiscord].map(u => [u.id, {
        user: { ...u, send: async payload => { calls.send.push(payload); } },
        guild: { id: guildId }, roles: { cache: new Map() }, permissions: { has: () => false },
    }]));
    const result = {
        customId, user, guildId, channelId, calls, deferred: false, replied: false,
        member: members.get(user.id),
        guild: {
            id: guildId,
            members: { fetch: async id => members.get(id) },
            roles: { fetch: async id => ({ id, permissions: { has: () => true } }) },
        },
        channel: {
            id: channelId, isThread: () => true, permissionsFor: () => ({ has: () => true }),
            send: async payload => { calls.send.push(payload); },
            setLocked: async value => { calls.locked.push(value); },
            setArchived: async value => { calls.archived.push(value); },
        },
        client: { users: { fetch: async id => members.get(id).user } },
        message: { embeds: [new EmbedBuilder().setTitle('Deal Test').toJSON()] },
        fields: { getTextInputValue: () => 'A detailed reason for this request.' },
        reply: async function (payload) { calls.reply.push(payload); this.replied = true; },
        followUp: async payload => { calls.followUp.push(payload); },
        editReply: async payload => { calls.editReply.push(payload); },
        deferUpdate: async function () { this.deferred = true; },
        deferReply: async function () { this.deferred = true; },
        showModal: async modal => { calls.modals.push(modal.toJSON()); },
        update: async payload => { calls.editReply.push(payload); },
        ...overrides,
    };
    return result;
}

function content(i) { return [...i.calls.reply, ...i.calls.followUp, ...i.calls.editReply].map(p => p.content || '').join(' '); }

test('cancellation modal refuses an outsider even with a valid deal ID', async () => {
    const e = deal();
    const i = interaction(`cancel_reason_modal_${e.id}`, otherDiscord);
    await cancelModal.execute(i);
    assert.match(content(i), /Only the buyer or seller/);
    assert.equal(repo.getEscrowById(e.id).status, 'pending');
    assert.equal(i.calls.send.length, 0);
});

test('stale cancellation modal cannot cancel an accepted deal', async () => {
    const e = deal();
    const i = interaction(`cancel_reason_modal_${e.id}`);
    repo.acceptEscrow(e.id, channelId, sellerDiscord.id);
    await cancelModal.execute(i);
    assert.match(content(i), /can no longer be cancelled/);
    assert.equal(repo.getEscrowById(e.id).status, 'awaiting_payment');
});

test('pending cancellation is allowed in DM and records the reason', async () => {
    const e = deal();
    const i = interaction(`cancel_reason_modal_${e.id}`, buyerDiscord, { guildId: null });
    await cancelModal.execute(i);
    assert.equal(repo.getEscrowById(e.id).status, 'cancelled');
    const event = repo.getEscrowEvents(e.id)[0];
    assert.equal(event.actor_discord_id, buyerDiscord.id);
    assert.match(event.reason, /detailed reason/);
    assert.equal(i.calls.editReply[0].components.length, 0);
});

test('actions cannot operate in another guild or thread', async () => {
    const e = deal('awaiting_payment');
    const wrongGuild = interaction(`confirm_payment_${e.id}`, buyerDiscord, { guildId: 'different' });
    await payment.execute(wrongGuild);
    assert.match(content(wrongGuild), /another server/);
    const wrongThread = interaction(`confirm_payment_${e.id}`, buyerDiscord, { channelId: 'different' });
    await payment.execute(wrongThread);
    assert.match(content(wrongThread), /private conversation/);
    assert.equal(repo.getEscrowById(e.id).status, 'awaiting_payment');
});

test('the seller cannot report payment on behalf of the buyer', async () => {
    const e = deal('awaiting_payment');
    const i = interaction(`confirm_payment_${e.id}`, sellerDiscord);
    await payment.execute(i);
    assert.match(content(i), /Only the buyer/);
    assert.equal(repo.getEscrowById(e.id).status, 'awaiting_payment');
});

test('payment, delivery and receipt handlers complete the workflow and reward exactly once', async () => {
    const e = deal('awaiting_payment');
    const pay = interaction(`confirm_payment_${e.id}`);
    await payment.execute(pay);
    assert.equal(repo.getEscrowById(e.id).status, 'funded');
    assert.equal(pay.calls.send[0].components[0].toJSON().components[0].custom_id, `confirm_delivery_${e.id}`);
    await delivery.execute(interaction(`confirm_delivery_${e.id}`, sellerDiscord));
    assert.equal(repo.getEscrowById(e.id).status, 'delivered');
    await receipt.execute(interaction(`confirm_receipt_${e.id}`));
    assert.equal(repo.getEscrowById(e.id).status, 'completed');
    const again = interaction(`confirm_receipt_${e.id}`);
    await receipt.execute(again);
    assert.match(content(again), /completed/);
    for (const u of [buyerDiscord, sellerDiscord]) {
        const identity = getOrCreateUser(u);
        const reputation = getGuildReputation(guildId, identity.id);
        assert.equal(reputation.trust_score, 5);
        assert.equal(reputation.successful_deals, 1);
        assert.equal(identity.trust_score, 0);
        assert.equal(getGuildReputation('another-server', identity.id).successful_deals, 0);
    }
});

test('opening a dispute asks for a reason before changing the deal', async () => {
    const e = deal('funded');
    setModeratorRole(guildId, 'moderator-role');
    const i = interaction(`open_dispute_${e.id}`);
    await openDispute.execute(i);
    assert.equal(i.calls.modals[0].custom_id, `dispute_reason_modal_${e.id}`);
    assert.equal(i.calls.modals[0].components[0].components[0].min_length, 10);
    assert.equal(repo.getEscrowById(e.id).status, 'funded');
});

test('a dispute reason is required and invalid reasons do not mutate the deal', async () => {
    const e = deal('funded');
    setModeratorRole(guildId, 'moderator-role');
    const i = interaction(`dispute_reason_modal_${e.id}`, buyerDiscord, { fields: { getTextInputValue: () => 'short' } });
    await disputeModal.execute(i);
    assert.match(content(i), /10 to 1,000/);
    assert.equal(repo.getEscrowById(e.id).status, 'funded');
});

test('unusable moderator role does not silently dispute a deal', async () => {
    const e = deal('funded');
    setModeratorRole(guildId, 'moderator-role');
    const i = interaction(`dispute_reason_modal_${e.id}`);
    i.channel.permissionsFor = () => ({ has: () => false });
    await disputeModal.execute(i);
    assert.match(content(i), /Manage Threads/);
    assert.equal(repo.getEscrowById(e.id).status, 'funded');
});

test('dispute reason is persisted and pauses the payment workflow', async () => {
    const e = deal('awaiting_payment');
    setModeratorRole(guildId, 'moderator-role');
    const i = interaction(`dispute_reason_modal_${e.id}`);
    await disputeModal.execute(i);
    assert.equal(repo.getEscrowById(e.id).status, 'disputed');
    assert.match(repo.getEscrowById(e.id).dispute_reason, /detailed reason/);
    assert.deepEqual(i.calls.editReply[0].allowedMentions.roles, ['moderator-role']);
    const stalePay = interaction(`confirm_payment_${e.id}`);
    await payment.execute(stalePay);
    assert.match(content(stalePay), /disputed/);
    assert.equal(repo.getEscrowById(e.id).status, 'disputed');
});

test('scammer selection rejects invalid choices and unauthorized members', async () => {
    const e = deal('disputed');
    const invalid = interaction(`scammer_pick_everyone_${e.id}`, moderatorDiscord);
    await scammer.execute(invalid);
    assert.match(content(invalid), /invalid/);
    const outsider = interaction(`scammer_pick_seller_${e.id}`);
    await scammer.execute(outsider);
    assert.match(content(outsider), /Only authorized moderators/);
    assert.equal(repo.getEscrowById(e.id).status, 'disputed');
});

test('scammer resolution cannot add duplicate flags using a stale button', async () => {
    const e = deal('disputed');
    const i = interaction(`scammer_pick_seller_${e.id}`, moderatorDiscord);
    i.member.permissions.has = () => true;
    await scammer.execute(i);
    assert.equal(repo.getEscrowById(e.id).status, 'cancelled');
    const again = interaction(`scammer_pick_seller_${e.id}`, moderatorDiscord);
    again.member.permissions.has = () => true;
    await scammer.execute(again);
    assert.match(content(again), /no open dispute/);
    const identity = getOrCreateUser(sellerDiscord);
    assert.equal(getGuildReputation(guildId, identity.id).scam_flag_count, 1);
    assert.equal(getGuildReputation(guildId, identity.id).failed_deals, 1);
    assert.equal(identity.is_scammer, 0);
    assert.equal(getGuildReputation('another-server', identity.id).is_scammer, 0);
});

test('moderator completion uses disputed transition and awards no duplicate points', async () => {
    const e = deal('disputed');
    const i = interaction(`resolve_complete_${e.id}`, moderatorDiscord);
    i.member.permissions.has = () => true;
    await resolveComplete.execute(i);
    const again = interaction(`resolve_complete_${e.id}`, moderatorDiscord);
    again.member.permissions.has = () => true;
    await resolveComplete.execute(again);
    assert.equal(repo.getEscrowById(e.id).status, 'completed');
    assert.equal(getGuildReputation(guildId, getOrCreateUser(buyerDiscord).id).successful_deals, 1);
    assert.equal(getGuildReputation(guildId, getOrCreateUser(sellerDiscord).id).trust_score, 5);
});

test('a new local scam decision immediately removes the member\'s cosmetic trust role', async () => {
    const e = deal('disputed');
    setRankRole(guildId, 'diamond', 'diamond-role');
    const i = interaction(`scammer_pick_seller_${e.id}`, moderatorDiscord);
    i.member.permissions.has = () => true;
    const removed = [];
    i.guild.members.fetchMe = async () => ({ permissions: { has: () => true }, roles: { highest: { position: 100 } } });
    i.guild.roles.cache = new Map([['diamond-role', {
        id: 'diamond-role', position: 1, editable: true, managed: false, permissions: { has: () => false },
    }]]);
    for (const id of [buyerDiscord.id, sellerDiscord.id]) {
        const member = await i.guild.members.fetch(id);
        member.guild = i.guild;
        member.roles.remove = async roleId => { removed.push({ id, roleId }); member.roles.cache.delete(roleId); };
    }
    const member = await i.guild.members.fetch(sellerDiscord.id);
    member.roles.cache.set('diamond-role', {});
    await scammer.execute(i);
    assert.deepEqual(removed, [{ id: sellerDiscord.id, roleId: 'diamond-role' }]);
    assert.equal(getGuildReputation(guildId, getOrCreateUser(sellerDiscord).id).is_scammer, 1);
});

test('active deals cannot be closed by participant approval', async () => {
    const e = deal('funded');
    const i = interaction(`approve_close_${e.id}`);
    await approveClose.execute(i);
    assert.match(content(i), /still active/);
    assert.equal(repo.getEscrowById(e.id).buyer_close_approved, 0);
    assert.equal(i.calls.archived.length, 0);
});

test('closing approvals work even when the old message has no embed', async () => {
    const e = deal('completed');
    const buyer = interaction(`approve_close_${e.id}`, buyerDiscord, { message: { embeds: [] } });
    await approveClose.execute(buyer);
    assert.equal(repo.getEscrowById(e.id).buyer_close_approved, 1);
    const seller = interaction(`approve_close_${e.id}`, sellerDiscord, { message: { embeds: [] } });
    await approveClose.execute(seller);
    assert.deepEqual(seller.calls.locked, [true]);
    assert.deepEqual(seller.calls.archived, [true]);
    assert.deepEqual(seller.calls.editReply[0].components, []);
});

test('acceptance denies the wrong seller before touching Discord', async () => {
    const e = deal();
    const i = interaction(`accept_escrow_${e.id}`);
    await accept.execute(i);
    assert.match(content(i), /designated seller/);
    assert.equal(repo.getEscrowById(e.id).status, 'pending');
});

test('acceptance cleans up only its newly created thread when setup fails', async () => {
    const e = deal();
    setHubChannel(guildId, 'hub');
    const i = interaction(`accept_escrow_${e.id}`, sellerDiscord);
    let deleted = 0;
    const thread = { id: channelId, members: { add: async () => {} }, send: async () => { throw new Error('Missing permissions'); }, delete: async () => { deleted++; } };
    const hub = { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }), threads: { create: async () => thread } };
    i.guild.channels = { fetch: async () => hub };
    i.guild.members.me = { id: 'bot' };
    i.client.guilds = { fetch: async () => i.guild };
    await accept.execute(i);
    assert.equal(deleted, 1);
    assert.equal(repo.getEscrowById(e.id).status, 'pending');
    assert.match(content(i), /was not accepted/);
});

test('both approved participants can retry closing after an archive failure', async () => {
    const e = deal('completed');
    const buyer = interaction(`approve_close_${e.id}`);
    await approveClose.execute(buyer);
    const seller = interaction(`approve_close_${e.id}`, sellerDiscord);
    seller.channel.setArchived = async () => { throw new Error('Temporary API failure'); };
    await approveClose.execute(seller);
    assert.equal(repo.getEscrowById(e.id).buyer_close_approved, 1);
    assert.equal(repo.getEscrowById(e.id).seller_close_approved, 1);
    assert.equal(seller.calls.editReply.at(-1).components[0].toJSON().components.length, 2);
    const retry = interaction(`approve_close_${e.id}`, sellerDiscord);
    await approveClose.execute(retry);
    assert.deepEqual(retry.calls.archived, [true]);
    assert.deepEqual(retry.calls.editReply[0].components, []);
});

test('a repeated approval waits for the other participant without archiving', async () => {
    const e = deal('completed');
    await approveClose.execute(interaction(`approve_close_${e.id}`));
    const again = interaction(`approve_close_${e.id}`);
    await approveClose.execute(again);
    assert.match(content(again), /Waiting for the other participant/);
    assert.equal(again.calls.archived.length, 0);
});

test('dispute permissions honor a moderator role channel override', async () => {
    const e = deal('funded');
    setModeratorRole(guildId, 'moderator-role');
    const i = interaction(`dispute_reason_modal_${e.id}`);
    i.guild.roles.fetch = async () => ({ id: 'moderator-role', permissions: { has: () => false } });
    i.channel.permissionsFor = role => ({ has: () => role.id === 'moderator-role' });
    await disputeModal.execute(i);
    assert.equal(repo.getEscrowById(e.id).status, 'disputed');
});

test('payment confirmation does not overwrite a state change during deferUpdate', async () => {
    const e = deal('awaiting_payment');
    const i = interaction(`confirm_payment_${e.id}`);
    i.deferUpdate = async function () {
        this.deferred = true;
        repo.markAsDisputed(e.id, 'A dispute was opened concurrently.', sellerDiscord.id);
    };
    await payment.execute(i);
    assert.equal(repo.getEscrowById(e.id).status, 'disputed');
    assert.match(content(i), /This deal changed/);
    assert.equal(i.calls.send.length, 0);
});

test('cancellation modal compare-and-set refuses a race after the state check', async () => {
    const e = deal();
    const i = interaction(`cancel_reason_modal_${e.id}`);
    i.deferUpdate = async function () {
        this.deferred = true;
        repo.acceptEscrow(e.id, channelId, sellerDiscord.id);
    };
    await cancelModal.execute(i);
    assert.equal(repo.getEscrowById(e.id).status, 'awaiting_payment');
    assert.match(content(i), /changed while you were responding/);
    assert.equal(i.calls.send.length, 0);
});

test('accepted private thread survives a later offer-update failure', async () => {
    const e = deal();
    setHubChannel(guildId, 'hub');
    const i = interaction(`accept_escrow_${e.id}`, sellerDiscord);
    let deleted = 0;
    let posts = 0;
    const thread = { id: channelId, members: { add: async () => {} }, send: async () => { posts++; }, delete: async () => { deleted++; } };
    const hub = { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }), threads: { create: async () => thread } };
    i.guild.channels = { fetch: async () => hub };
    i.guild.members.me = { id: 'bot' };
    i.client.guilds = { fetch: async () => i.guild };
    i.editReply = async () => { throw new Error('Offer no longer available'); };
    await accept.execute(i);
    assert.equal(posts, 2);
    assert.equal(deleted, 0);
    assert.equal(repo.getEscrowById(e.id).status, 'awaiting_payment');
    assert.match(content(i), /deal was accepted/);
    assert.match(content(i), new RegExp(channelId));
});

test('deal offer modal rejects a malformed amount before fetching messages', async () => {
    const i = interaction('deal_offer_modal_money_300000000000000001_400000000000000001_100000000000000001');
    i.fields.getTextInputValue = name => name === 'amount' ? '25invalid' : 'USD';
    await offerModal.execute(i);
    assert.match(content(i), /positive amount/);
    assert.equal(i.deferred, false);
});

test('deal offer modal cannot read a private thread after membership is removed', async () => {
    const i = interaction('deal_offer_modal_money_300000000000000001_400000000000000001_100000000000000001');
    i.fields.getTextInputValue = name => name === 'amount' ? '25.50' : 'USD';
    let reads = 0;
    i.guild.channels = { fetch: async () => ({
        guildId, type: ChannelType.PrivateThread, isTextBased: () => true,
        permissionsFor: () => ({ has: flags => Array.isArray(flags) }),
        members: { fetch: async () => null },
        messages: { fetch: async () => { reads++; } },
    }) };
    await offerModal.execute(i);
    assert.match(content(i), /no longer a member/);
    assert.equal(reads, 0);
});
