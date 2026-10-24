process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { createEscrow, getEscrowById, getEscrowEvents } = require('../src/database/escrowRepository');
const router = require('../src/events/interactionCreate');

beforeEach(() => db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users;'));
after(() => db.close());
function offer() {
    const buyer = getOrCreateUser({ id: 'buyer', tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: 'seller', tag: 'Seller', createdAt: new Date('2020-01-01') });
    const escrow = createEscrow({ guildId: 'market', buyerId: buyer.id, sellerId: seller.id, itemDescription: 'Cape', amount: 2 });
    db.prepare("UPDATE escrow_transactions SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(escrow.id);
    return escrow;
}
function button(escrow, guildId = null) {
    const replies = [];
    return {
        customId: `accept_escrow_${escrow.id}`, guildId, channelId: 'old-dm', user: { id: 'seller' },
        isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
        isButton: () => true, isModalSubmit: () => false,
        reply: async payload => replies.push(payload), replies,
    };
}

test('a stale DM accept control expires an unaccepted offer and explains that it ended', async () => {
    const escrow = offer();
    const input = button(escrow);
    let called = false;
    await router.execute(input, { buttons: [{ id: 'accept_escrow_', execute: async () => { called = true; } }] });
    assert.equal(called, false);
    assert.equal(getEscrowById(escrow.id).status, 'cancelled');
    assert.equal(getEscrowEvents(escrow.id).filter(event => event.event_type === 'offer_expired').length, 1);
    assert.equal(input.replies[0].ephemeral, true);
    assert.match(input.replies[0].content, /ended or expired/);
    assert.doesNotMatch(input.replies[0].content, /inside.*thread/);
});

test('cross-server controls are rejected before mutating an unrelated pending offer', async () => {
    const escrow = offer();
    const input = button(escrow, 'other-market');
    await router.execute(input, { buttons: [{ id: 'accept_escrow_', execute: async () => assert.fail('Wrong server handler ran') }] });
    assert.match(input.replies[0].content, /different server/);
    assert.equal(getEscrowById(escrow.id).status, 'pending');
});
