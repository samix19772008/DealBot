process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { db } = require('../src/database/init');
const users = require('../src/database/userRepository');
const repo = require('../src/database/escrowRepository');
const command = require('../src/commands/escrow/deals');
const pages = require('../src/interactions/buttons/dealsDashboard');
const filters = require('../src/interactions/selects/dealsFilter');
const pick = require('../src/interactions/selects/dealsPick');
const { buildDealDashboard, parseDashboardControl } = require('../src/utils/dealDashboard');

const guildId = '930000000000000001';
const buyerId = '930000000000000002';
const sellerId = '930000000000000003';
let sequence = 0;
beforeEach(() => db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;'));
after(() => db.close());

function discordUser(id) { return { id, tag: `Trader ${id}`, createdAt: new Date('2020-01-01') }; }
function seed({ guild = guildId, buyer = buyerId, seller = sellerId, status = 'pending', item = `Item ${++sequence}` } = {}) {
    const b = users.getOrCreateUser(discordUser(buyer));
    const s = users.getOrCreateUser(discordUser(seller));
    const deal = repo.createEscrow({ guildId: guild, buyerId: b.id, sellerId: s.id, itemDescription: item, amount: 2, currency: 'USD' });
    if (status !== 'pending' && status !== 'cancelled') repo.acceptEscrow(deal.id, `thread-${deal.id}`, seller);
    if (['funded', 'delivered', 'completed'].includes(status)) repo.markAsFunded(deal.id, buyer);
    if (['delivered', 'completed'].includes(status)) repo.markAsDelivered(deal.id, seller);
    if (status === 'completed') repo.completeEscrow(deal.id, b.id, s.id, buyer);
    if (status === 'cancelled') repo.cancelEscrow(deal.id, { actorId: buyer });
    if (status === 'disputed') repo.markAsDisputed(deal.id, 'A test dispute needs staff review.', buyer);
    return repo.getEscrowById(deal.id);
}
function input(overrides = {}) {
    const calls = { replies: [], updates: [] };
    return { guildId, user: { id: buyerId }, channelId: 'general', calls,
        options: { getString: () => 'active', getInteger: () => 1 },
        member: { guild: { id: guildId }, permissions: new PermissionsBitField(), roles: { cache: new Map() } },
        reply: async function(payload) { this.replied = true; calls.replies.push(payload); },
        followUp: async payload => calls.replies.push(payload),
        update: async function(payload) { this.replied = true; calls.updates.push(payload); },
        ...overrides };
}
const rowItems = payload => payload.components.flatMap(row => row.toJSON().components);
const findControl = (payload, prefix) => rowItems(payload).find(control => control.custom_id.startsWith(prefix));
const fieldNames = payload => (payload.embeds[0].toJSON().fields || []).map(field => field.name);
const marker = deal => `Deal #${String(deal.id).padStart(4, '0')} ·`;

test('private dashboard uses compact deal numbers and exposes only the caller\'s server records', async () => {
    const own = seed({ item: 'Menace Cape\nQuantity: 2\nSource: private details' });
    seed({ guild: 'other-guild', item: 'Foreign server secret' });
    seed({ buyer: 'other-buyer', seller: 'other-seller', item: 'Other traders secret' });
    const interaction = input();
    await command.execute(interaction);
    const payload = interaction.calls.replies[0];
    assert.equal(payload.ephemeral, true);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.deepEqual(fieldNames(payload), [`${marker(own)} Menace Cape`]);
    assert.doesNotMatch(JSON.stringify(payload.embeds[0].toJSON()), /Foreign server secret|Other traders secret|Source: private details|ESC-/);
    assert.match(payload.embeds[0].toJSON().description, /Active:\*\* 1/);
    const choices = findControl(payload, 'deals_filter_').options.map(option => option.value);
    assert.deepEqual(choices, ['active', 'attention', 'completed', 'all']);
});

test('previous, next and refresh update the same private view and clamp disappearing history pages', async () => {
    for (let index = 0; index < 8; index++) seed();
    const first = buildDealDashboard({ guildId, userId: buyerId, status: 'all', page: 1 });
    const next = rowItems(first).find(control => control.label === 'Next');
    assert.equal(next.disabled, false);
    const interaction = input({ customId: next.custom_id });
    await pages.execute(interaction);
    assert.equal(interaction.calls.replies.length, 0);
    const second = interaction.calls.updates[0];
    assert.equal(fieldNames(first).length, 6);
    assert.equal(fieldNames(second).length, 2);
    assert.ok(!fieldNames(first).some(name => fieldNames(second).includes(name)));
    assert.match(second.embeds[0].toJSON().footer.text, /Page 2\/2/);
    const refresh = rowItems(second).find(control => control.label === 'Refresh');
    db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions;');
    const stale = input({ customId: refresh.custom_id });
    await pages.execute(stale);
    const refreshed = stale.calls.updates[0];
    assert.equal(fieldNames(refreshed).length, 0);
    assert.match(refreshed.embeds[0].toJSON().footer.text, /Page 1\/1/);
    assert.equal(findControl(refreshed, 'deals_pick_'), undefined);
    for (const control of rowItems(refreshed).filter(control => ['Previous', 'Next'].includes(control.label))) {
        assert.equal(control.disabled, true);
    }
});

test('needs-your-action distinguishes each participant role and leaves disputes with staff', async () => {
    const expected = [
        seed({ buyer: sellerId, seller: buyerId, item: 'Accept this request' }),
        seed({ status: 'awaiting_payment', item: 'Send this payment' }),
        seed({ buyer: sellerId, seller: buyerId, status: 'funded', item: 'Deliver this item' }),
        seed({ status: 'delivered', item: 'Confirm this receipt' }),
    ];
    seed({ item: 'Waiting for the other seller' });
    seed({ buyer: sellerId, seller: buyerId, status: 'awaiting_payment', item: 'Waiting for the other buyer' });
    seed({ status: 'funded', item: 'Waiting for delivery' });
    seed({ buyer: sellerId, seller: buyerId, status: 'delivered', item: 'Waiting for receipt' });
    seed({ status: 'disputed', item: 'Waiting for staff' });
    const payload = buildDealDashboard({ guildId, userId: buyerId, status: 'attention' });
    assert.equal(fieldNames(payload).length, 4);
    assert.ok(expected.every(deal => fieldNames(payload).some(name => name.startsWith(marker(deal)))));
    assert.match(payload.embeds[0].toJSON().description, /Needs your action:\*\* 4/);
    assert.ok(payload.embeds[0].toJSON().fields.every(field => field.value.includes('Your turn')));
});

test('filter changes reset pagination and show completed history independently of active deals', async () => {
    const completed = seed({ status: 'completed', item: 'Finished cape' });
    seed({ item: 'Active cape' });
    const payload = buildDealDashboard({ guildId, userId: buyerId });
    const interaction = input({ customId: findControl(payload, 'deals_filter_').custom_id, values: ['completed'] });
    await filters.execute(interaction);
    const updated = interaction.calls.updates[0];
    assert.deepEqual(fieldNames(updated), [`${marker(completed)} Finished cape`]);
    assert.match(updated.embeds[0].toJSON().title, /Completed/);
    assert.match(updated.embeds[0].toJSON().footer.text, /Page 1\/1/);
    assert.equal(findControl(updated, 'deals_filter_').options.find(option => option.value === 'completed').default, true);
});

test('all dashboard controls reject a different user or server before returning any deal data', async () => {
    seed();
    const payload = buildDealDashboard({ guildId, userId: buyerId });
    const candidates = [
        [pages, rowItems(payload).find(control => control.label === 'Refresh').custom_id, undefined],
        [filters, findControl(payload, 'deals_filter_').custom_id, ['all']],
        [pick, findControl(payload, 'deals_pick_').custom_id, [findControl(payload, 'deals_pick_').options[0].value]],
    ];
    for (const [handler, customId, values] of candidates) {
        for (const changes of [{ user: { id: 'another-user' } }, { guildId: 'another-guild' }, { guildId: null }]) {
            const interaction = input({ customId, values, ...changes });
            await handler.execute(interaction);
            assert.equal(interaction.calls.updates.length, 0);
            assert.equal(interaction.calls.replies.length, 1);
            assert.equal(interaction.calls.replies[0].ephemeral, true);
            assert.equal(interaction.calls.replies[0].embeds, undefined);
            assert.match(interaction.calls.replies[0].content, /another user or server|own deals/);
        }
    }
});

test('selected own deal reveals its full reference and only conversation visibility actions outside its thread', async () => {
    const deal = seed({ status: 'funded' });
    const payload = buildDealDashboard({ guildId, userId: buyerId });
    const interaction = input({ customId: findControl(payload, 'deals_pick_').custom_id, values: [String(deal.id)], options: undefined });
    await pick.execute(interaction);
    const detail = interaction.calls.replies[0];
    assert.equal(detail.ephemeral, true);
    assert.match(detail.embeds[0].toJSON().description, new RegExp(deal.transaction_uuid));
    assert.deepEqual(rowItems(detail).map(control => control.custom_id), [`deals_resume_${deal.id}`, `deals_hide_${deal.id}`]);
    assert.deepEqual(rowItems(detail).map(control => control.label), ['Open Conversation', 'Hide Conversation']);
    assert.deepEqual(detail.allowedMentions, { parse: [] });
    assert.doesNotMatch(JSON.stringify(detail.components.map(row => row.toJSON())), /confirm_payment_|confirm_receipt_|confirm_delivery_|open_dispute_/);
});

test('a forged selector cannot reveal other traders\' deal even to a moderator with their own dashboard', async () => {
    seed();
    const other = seed({ buyer: 'third-buyer', seller: 'third-seller', item: 'Private unrelated trade' });
    const payload = buildDealDashboard({ guildId, userId: buyerId });
    const interaction = input({ customId: findControl(payload, 'deals_pick_').custom_id, values: [String(other.id)],
        member: { guild: { id: guildId }, roles: { cache: new Map() }, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) } });
    await pick.execute(interaction);
    assert.equal(interaction.calls.replies[0].embeds, undefined);
    assert.match(interaction.calls.replies[0].content, /not in your private dashboard/);
    assert.doesNotMatch(JSON.stringify(interaction.calls.replies), /Private unrelated trade/);
});

test('completed deal selections remain read-only outside their archived conversation', async () => {
    const deal = seed({ status: 'completed' });
    const payload = buildDealDashboard({ guildId, userId: buyerId, status: 'completed' });
    const interaction = input({ customId: findControl(payload, 'deals_pick_').custom_id, values: [String(deal.id)] });
    await pick.execute(interaction);
    assert.deepEqual(rowItems(interaction.calls.replies[0]).map(control => control.custom_id), [`deals_transcript_${deal.id}`]);
    assert.equal(rowItems(interaction.calls.replies[0])[0].label, 'Download Transcript');
    assert.match(interaction.calls.replies[0].embeds[0].toJSON().description, new RegExp(deal.transaction_uuid));
});

test('a disputed deal offers opening its conversation without hiding it or downloading a closing transcript', async () => {
    const deal = seed({ status: 'disputed' });
    const payload = buildDealDashboard({ guildId, userId: buyerId });
    const interaction = input({ customId: findControl(payload, 'deals_pick_').custom_id, values: [String(deal.id)] });
    await pick.execute(interaction);
    assert.deepEqual(rowItems(interaction.calls.replies[0]).map(control => control.custom_id), [`deals_resume_${deal.id}`]);
});

test('malformed controls and unsupported filters fail privately while valid IDs fit Discord limits', async () => {
    seed();
    const payload = buildDealDashboard({ guildId, userId: buyerId });
    for (const row of payload.components) {
        for (const component of row.toJSON().components) assert.ok(component.custom_id.length <= 100);
    }
    for (const [handler, customId, values] of [
        [pages, `deals_page_${guildId}:${buyerId}:active:0:next`],
        [pages, `deals_page_${guildId}:${buyerId}:active:1:delete`],
        [filters, findControl(payload, 'deals_filter_').custom_id, ['private-all-users']],
        [filters, findControl(payload, 'deals_filter_').custom_id, ['active', 'all']],
        [pick, findControl(payload, 'deals_pick_').custom_id, ['bad-id']],
    ]) {
        const interaction = input({ customId, values });
        await handler.execute(interaction);
        assert.equal(interaction.calls.replies[0].ephemeral, true);
        assert.equal(interaction.calls.updates.length, 0);
    }
    const maximal = `deals_page_${'g'.repeat(32)}:${'u'.repeat(32)}:attention:1000:refresh`;
    assert.ok(maximal.length <= 100);
    assert.equal(parseDashboardControl(input({ customId: maximal, guildId: 'g'.repeat(32), user: { id: 'u'.repeat(32) } }), 'deals_page_', { action: true }).page, 1000);
});
