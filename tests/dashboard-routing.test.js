process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { createEscrow } = require('../src/database/escrowRepository');
const router = require('../src/events/interactionCreate');
const { processingDeals } = require('../src/utils/dealLocks');

beforeEach(() => { router.processingDeals.clear(); db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users;'); });
after(() => db.close());
function accepted() {
    const identity = id => getOrCreateUser({ id, tag: id, createdAt: new Date('2020-01-01') }).id;
    const deal = createEscrow({ guildId: 'market', buyerId: identity('buyer'), sellerId: identity('seller'),
        itemDescription: 'Cape', amount: 2 });
    db.prepare("UPDATE escrow_transactions SET status = 'awaiting_payment', channel_id = 'thread' WHERE id = ?").run(deal.id);
    return deal;
}
function input(customId, guildId = 'market') {
    const replies = [];
    return { customId, guildId, channelId: 'general', user: { id: 'buyer' },
        isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
        isButton: () => true, isModalSubmit: () => false,
        reply: async payload => { replies.push(payload); }, replies };
}

test('dashboard navigation routes bound payloads without treating them as numeric deal actions', async () => {
    for (const prefix of ['deals_page_', 'deals_filter_', 'deals_pick_']) {
        const interaction = input(`${prefix}market:buyer:active:1`);
        let calls = 0;
        await router.execute(interaction, { buttons: [{ id: prefix, execute: async () => { calls++; } }] });
        assert.equal(calls, 1);
        assert.equal(interaction.replies.length, 0);
    }
});

test('only resume bypasses original-thread routing and still shares the background deal lock', async () => {
    const deal = accepted();
    assert.equal(router.processingDeals, processingDeals);
    let calls = 0;
    const client = { buttons: [
        { id: 'deals_resume_', execute: async () => { assert.ok(processingDeals.has(String(deal.id))); calls++; } },
        { id: 'confirm_payment_', execute: async () => assert.fail('Thread action escaped its conversation') },
    ] };
    await router.execute(input(`deals_resume_${deal.id}`), client);
    assert.equal(calls, 1);
    assert.equal(processingDeals.size, 0);
    const originalAction = input(`confirm_payment_${deal.id}`);
    await router.execute(originalAction, client);
    assert.match(originalAction.replies[0].content, /original deal thread/);
    processingDeals.add(String(deal.id));
    const busy = input(`deals_resume_${deal.id}`);
    await router.execute(busy, client);
    assert.equal(calls, 1);
    assert.match(busy.replies[0].content, /Another action/);
});

test('cross-server and DM resume controls never reach the handler', async () => {
    const deal = accepted();
    for (const guildId of ['other-market', null]) {
        const interaction = input(`deals_resume_${deal.id}`, guildId);
        await router.execute(interaction, { buttons: [{ id: 'deals_resume_', execute: async () => assert.fail('Wrong scope resumed') }] });
        assert.equal(interaction.replies[0].ephemeral, true);
        assert.match(interaction.replies[0].content, /different server|inside the deal thread/);
    }
});
