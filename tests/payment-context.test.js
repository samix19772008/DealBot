process.env.DATABASE_PATH = ':memory:';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { setHubChannel } = require('../src/database/guildSettingsRepository');
const contextCommand = require('../src/commands/context/dealOnMessage');
const selection = require('../src/interactions/selects/paymentMethod');
const offerModal = require('../src/interactions/modals/dealOfferModal');
const { REQUIRED_HUB_PERMISSIONS } = require('../src/utils/dealOffer');
const router = require('../src/events/interactionCreate');
const { loadSelects } = require('../src/handlers/selectHandler');

let sequence = 0;
const id = () => String(800000000000000000n + BigInt(++sequence));
function fixture() {
    const calls = { reply: [], edit: [], follow: [], modal: [], dm: [], reads: 0, membership: 0, channelFetches: 0 };
    const guildId = id();
    const buyer = { id: id(), tag: 'buyer', bot: false, createdAt: new Date('2020-01-01') };
    const seller = { id: id(), tag: 'seller', bot: false, createdAt: new Date('2020-01-01'), send: async payload => { calls.dm.push(payload); } };
    const member = { id: buyer.id };
    const bot = { id: id() };
    const sourceId = id();
    const messageId = id();
    const targetMessage = { id: messageId, channelId: sourceId, guildId, author: seller,
        content: 'A game item for sale', url: `https://discord.com/channels/${guildId}/${sourceId}/${messageId}` };
    const source = {
        id: sourceId, guildId, type: ChannelType.GuildText, isTextBased: () => true,
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]),
        messages: { fetch: async () => { calls.reads++; return targetMessage; } },
        members: { fetch: async () => { calls.membership++; return { id: buyer.id }; } },
    };
    const hub = { id: id(), type: ChannelType.GuildText, permissionsFor: () => new PermissionsBitField(REQUIRED_HUB_PERMISSIONS) };
    const guild = { id: guildId, name: 'Test Server', channels: { fetch: async channelId => { calls.channelFetches++; return channelId === sourceId ? source : channelId === hub.id ? hub : null; } },
        members: { fetchMe: async () => bot, fetch: async userId => userId === buyer.id ? member : { id: seller.id } } };
    setHubChannel(guildId, hub.id);
    function interaction(overrides = {}) {
        return {
            user: buyer, member, guildId, guild, channelId: sourceId, targetMessage,
            customId: `deal_payment_method_${sourceId}_${messageId}_${buyer.id}`,
            values: ['money'], deferred: false, replied: false,
            fields: { getTextInputValue: key => key === 'amount' ? '25.50' : '' },
            reply: async function (payload) { this.replied = true; calls.reply.push(payload); },
            followUp: async payload => { calls.follow.push(payload); },
            editReply: async payload => { calls.edit.push(payload); },
            deferReply: async function () { this.deferred = true; },
            showModal: async modal => { calls.modal.push(modal.toJSON()); },
            isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
            isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false,
            ...overrides,
        };
    }
    function modal(method, amount = '25.50', unit = '') {
        return interaction({ customId: `deal_offer_modal_${method}_${sourceId}_${messageId}_${buyer.id}`,
            fields: { getTextInputValue: key => key === 'amount' ? amount : unit } });
    }
    return { calls, buyer, seller, source, targetMessage, interaction, modal, sourceId, messageId };
}

beforeEach(() => {
    db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;');
    router.processingDeals.clear();
});
after(() => db.close());

const responseContent = calls => [...calls.reply, ...calls.edit, ...calls.follow].map(payload => payload.content || '').join(' ');

test('Request a Deal shows a private menu with exactly the four supported payment methods', async () => {
    const f = fixture();
    await contextCommand.execute(f.interaction());
    assert.equal(f.calls.reply[0].ephemeral, true);
    const menu = f.calls.reply[0].components[0].toJSON().components[0];
    assert.deepEqual(menu.options.map(option => ({ label: option.label, value: option.value })), [
        { label: 'Money', value: 'money' },
        { label: 'Golds', value: 'golds' },
        { label: 'Redblocks', value: 'redblocks' },
        { label: 'Sky 1 Notchs', value: 'sky1notchs' },
    ]);
    assert.equal(menu.custom_id, `deal_payment_method_${f.sourceId}_${f.messageId}_${f.buyer.id}`);
    assert.ok(menu.custom_id.length <= 100);
});

test('method selection opens an amount-only Money form or a game form with an optional stack unit', async () => {
    const f = fixture();
    for (const method of ['money', 'golds', 'redblocks', 'sky1notchs']) {
        await selection.execute(f.interaction({ values: [method] }));
        const modal = f.calls.modal.at(-1);
        assert.equal(modal.custom_id, `deal_offer_modal_${method}_${f.sourceId}_${f.messageId}_${f.buyer.id}`);
        assert.ok(modal.custom_id.length <= 100);
        assert.equal(modal.components[0].components[0].custom_id, 'amount');
        assert.equal(modal.components.length, method === 'money' ? 1 : 2);
        if (method !== 'money') {
            assert.equal(modal.components[1].components[0].custom_id, 'payment_unit');
            assert.equal(modal.components[1].components[0].required, false);
        }
    }
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.channelFetches, 0);
});

test('selection rejects another buyer and unknown payment values before reading a source message', async () => {
    const f = fixture();
    await selection.execute(f.interaction({ user: { ...f.buyer, id: id() } }));
    assert.match(responseContent(f.calls), /Only the person/);
    await selection.execute(f.interaction({ values: ['other-currency'] }));
    assert.match(responseContent(f.calls), /Choose Money/);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.modal.length, 0);
});

test('selection responds with a modal without awaiting source-channel REST requests', async () => {
    const f = fixture();
    const input = f.interaction();
    input.guild.channels.fetch = async () => { throw new Error('A slow or unavailable source must not delay the modal'); };
    await selection.execute(input);
    assert.equal(f.calls.modal.length, 1);
    assert.equal(f.calls.channelFetches, 0);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.membership, 0);
});

test('submitted form checks current channel access and private-thread membership before reading', async () => {
    const f = fixture();
    await selection.execute(f.interaction());
    assert.equal(f.calls.modal.length, 1);
    f.source.permissionsFor = () => new PermissionsBitField();
    const inaccessible = f.modal('money');
    await offerModal.execute(inaccessible);
    assert.equal(inaccessible.deferred, true);
    assert.match(responseContent(f.calls), /no longer access.*Open the deal request again/);
    assert.equal(f.calls.reads, 0);
    f.source.type = ChannelType.PrivateThread;
    f.source.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
    f.source.members.fetch = async () => { f.calls.membership++; return null; };
    const notMember = f.modal('money');
    await offerModal.execute(notMember);
    assert.equal(notMember.deferred, true);
    assert.match(responseContent(f.calls), /no longer a member/);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.membership, 1);
    assert.equal(f.calls.dm.length, 0);
});

test('a removed or bot-owned source message cannot create a deal after form submission', async () => {
    const f = fixture();
    await selection.execute(f.interaction());
    assert.equal(f.calls.modal.length, 1);
    f.source.messages.fetch = async () => null;
    await offerModal.execute(f.modal('money'));
    assert.match(responseContent(f.calls), /source message could not be found/);
    f.source.messages.fetch = async () => ({ ...f.targetMessage, author: { ...f.seller, bot: true } });
    await offerModal.execute(f.modal('money'));
    assert.match(responseContent(f.calls), /bot message/);
    assert.equal(f.calls.dm.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, 0);
});

test('legacy forms expire clearly and another buyer cannot submit a payment form', async () => {
    const f = fixture();
    await offerModal.execute(f.interaction({ customId: `deal_offer_modal_${f.sourceId}_${f.messageId}` }));
    assert.match(responseContent(f.calls), /expired.*Reopen Request a Deal/);
    const other = f.modal('money');
    other.user = { ...f.buyer, id: id() };
    await offerModal.execute(other);
    assert.match(responseContent(f.calls), /Only the person/);
    assert.equal(f.calls.reads, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, 0);
});

test('payment form rejects partial, fractional-game, and unknown-unit amounts before reading the source', async () => {
    for (const [method, amount, unit] of [
        ['money', '25invalid', ''], ['money', '1.001', ''], ['golds', '1.5', 'each'],
        ['redblocks', '0.5', 'stacks'], ['sky1notchs', '2', 'boxes'],
    ]) {
        const f = fixture();
        const input = f.modal(method, amount, unit);
        await offerModal.execute(input);
        assert.equal(f.calls.reads, 0);
        assert.equal(input.deferred, false);
        assert.ok(responseContent(f.calls).length > 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, 0);
    }
});

test('payment form rechecks private-thread membership after a valid selection', async () => {
    const f = fixture();
    f.source.type = ChannelType.PrivateThread;
    await selection.execute(f.interaction({ values: ['golds'] }));
    assert.equal(f.calls.modal.length, 1);
    f.source.members.fetch = async () => null;
    await offerModal.execute(f.modal('golds', '2', 'stacks'));
    assert.match(responseContent(f.calls), /no longer a member/);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.dm.length, 0);
});

test('Money form creates a USD deal without reading an unrelated unit field', async () => {
    const f = fixture();
    const input = f.modal('money');
    input.fields.getTextInputValue = field => {
        assert.equal(field, 'amount');
        return '25.50';
    };
    await offerModal.execute(input);
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    assert.equal(row.amount, 25.5);
    assert.equal(row.currency, 'USD');
    assert.equal(row.payment_unit, 'each');
    assert.equal(f.calls.dm.length, 1);
    assert.match(responseContent(f.calls), /sent.*via DM/);
});

test('game form records an explicit stack agreement and shows its exact individual item total', async () => {
    const f = fixture();
    await offerModal.execute(f.modal('redblocks', '2', 'stacks'));
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    assert.equal(row.amount, 2);
    assert.equal(row.currency, 'Redblocks');
    assert.equal(row.payment_unit, 'stacks');
    const amountField = f.calls.dm[0].embeds[0].toJSON().fields.find(field => field.name === 'Agreed Payment');
    assert.match(amountField.value, /2 stacks of Redblocks \(128 blocks\)/);
});

test('select handlers load at startup and the router dispatches them without treating source IDs as escrow IDs', async () => {
    const client = { commands: new Map(), buttons: [], modals: [] };
    loadSelects(client);
    assert.ok(client.selects.some(handler => handler.id === 'deal_payment_method_'));
    const f = fixture();
    const input = f.interaction({ isStringSelectMenu: () => true });
    input.client = client;
    await router.execute(input, client);
    assert.equal(f.calls.modal.length, 1);
    assert.equal(router.processingDeals.size, 0);
    assert.equal(router.getActionEscrowId(input, selection), null);
});


test('embed-only listings retain a bounded title and description without parsing their price alternatives', async () => {
    const f = fixture();
    f.targetMessage.content = '';
    f.targetMessage.embeds = [{ title: 'Menace Cape', description: 'Money $2 · Golds 45 · Redblocks 20 stacks · Sky 1 Notchs 20' }];
    await offerModal.execute(f.modal('redblocks', '20', 'stacks'));
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    assert.equal(row.item_description, 'Menace Cape\nMoney $2 · Golds 45 · Redblocks 20 stacks · Sky 1 Notchs 20');
    assert.equal(row.amount, 20);
    assert.equal(row.currency, 'Redblocks');
    assert.equal(row.payment_unit, 'stacks');
    const long = fixture();
    long.targetMessage.content = '';
    long.targetMessage.embeds = [{ title: 'Long Listing', description: 'x'.repeat(2000) }];
    await offerModal.execute(long.modal('money', '2'));
    const longRow = db.prepare('SELECT * FROM escrow_transactions WHERE guild_id = ?').get(long.interaction().guildId);
    assert.equal(longRow.item_description.length, 1000);
    assert.match(longRow.item_description, /^Long Listing\n/);
    assert.ok(longRow.item_description.endsWith('…'));
});
