process.env.DATABASE_PATH = ':memory:';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { setHubChannel } = require('../src/database/guildSettingsRepository');
const { getListingRequest, getEscrowListingTerms } = require('../src/database/listingRepository');
const contextCommand = require('../src/commands/context/dealOnMessage');
const selection = require('../src/interactions/selects/paymentMethod');
const offerModal = require('../src/interactions/modals/dealOfferModal');
const { REQUIRED_HUB_PERMISSIONS } = require('../src/utils/dealOffer');
const router = require('../src/events/interactionCreate');
const { loadSelects } = require('../src/handlers/selectHandler');

let sequence = 0;
const id = () => String(800000000000000000n + BigInt(++sequence));
const FULL_LISTING = 'Item: Menace Cape\nMoney: $2.00\nGolds: 33\nRedblocks: 20 stacks\nSky 1 Notchs: 20';

function fixture(content = FULL_LISTING) {
    const calls = { reply: [], edit: [], follow: [], modal: [], dm: [], deferrals: [],
        messageRequests: [], membershipRequests: [], channelRequests: [], reads: 0, membership: 0, channelFetches: 0 };
    const guildId = id();
    const buyer = { id: id(), tag: 'buyer', bot: false, createdAt: new Date('2020-01-01') };
    const seller = { id: id(), tag: 'seller', bot: false, createdAt: new Date('2020-01-01'), send: async payload => { calls.dm.push(payload); } };
    const member = { id: buyer.id };
    const bot = { id: id() };
    const sourceId = id();
    const messageId = id();
    const targetMessage = { id: messageId, channelId: sourceId, guildId, author: seller,
        content, editedTimestamp: null, url: `https://discord.com/channels/${guildId}/${sourceId}/${messageId}` };
    const source = {
        id: sourceId, guildId, type: ChannelType.GuildText, isTextBased: () => true,
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]),
        messages: { fetch: async options => { calls.reads++; calls.messageRequests.push(options); return targetMessage; } },
        members: { fetch: async options => { calls.membership++; calls.membershipRequests.push(options); return { id: buyer.id }; } },
    };
    const hub = { id: id(), type: ChannelType.GuildText, permissionsFor: () => new PermissionsBitField(REQUIRED_HUB_PERMISSIONS) };
    const guild = { id: guildId, name: 'Test Server', channels: { fetch: async (channelId, options) => {
        calls.channelFetches++;
        calls.channelRequests.push({ channelId, options });
        return channelId === sourceId ? source : channelId === hub.id ? hub : null;
    } }, members: { fetchMe: async () => bot, fetch: async userId => userId === buyer.id ? member : { id: seller.id } } };
    setHubChannel(guildId, hub.id);
    function interaction(overrides = {}) {
        return {
            user: buyer, member, guildId, guild, channelId: sourceId, targetMessage,
            values: ['money'], deferred: false, replied: false,
            reply: async function (payload) { this.replied = true; calls.reply.push(payload); },
            followUp: async payload => { calls.follow.push(payload); },
            editReply: async payload => { calls.edit.push(payload); },
            deferReply: async function (payload) { this.deferred = true; calls.deferrals.push(payload); },
            showModal: async modal => { calls.modal.push(modal.toJSON()); },
            isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
            isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false,
            ...overrides,
        };
    }
    async function open() {
        const input = interaction();
        await contextCommand.execute(input);
        const menu = calls.edit.at(-1)?.components?.[0]?.toJSON().components[0];
        assert.ok(menu, responseContent(calls));
        return { menu, token: menu.custom_id.slice('deal_payment_method_v2_'.length), input };
    }
    function choose(token, method = 'money', overrides = {}) {
        return interaction({ customId: `deal_payment_method_v2_${token}`, values: [method], ...overrides });
    }
    function modal(token, method = 'money', quantity = '1', overrides = {}) {
        return interaction({ customId: `deal_offer_modal_v2_${token}_${method}`,
            fields: { getTextInputValue: key => {
                assert.equal(key, 'quantity', 'A listing form must never read a buyer-entered amount or unit');
                return quantity;
            } }, ...overrides });
    }
    return { calls, buyer, seller, source, targetMessage, interaction, modal, choose, open, guild, guildId, sourceId, messageId };
}

beforeEach(() => {
    db.exec('DELETE FROM listing_request_sessions; DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings; DELETE FROM offer_cooldowns;');
    router.processingDeals.clear();
});
after(() => db.close());

function responseContent(calls) {
    return [...calls.reply, ...calls.edit, ...calls.follow].map(payload => payload.content || '').join(' ');
}
const dealCount = () => db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count;

function assertNoDeal(f) {
    assert.equal(dealCount(), 0);
    assert.equal(f.calls.dm.length, 0);
}

test('Request a Deal privately displays only the seller methods and each advertised unit price', async () => {
    const f = fixture('Item: Menace Cape\nGolds: 33\nMoney: $2.00');
    const { menu, token, input } = await f.open();
    assert.equal(input.deferred, true);
    assert.equal(f.calls.deferrals[0].ephemeral, true);
    assert.equal(f.calls.reply.length, 0);
    assert.deepEqual(menu.options.map(option => ({ label: option.label, value: option.value })), [
        { label: 'Golds', value: 'golds' }, { label: 'Money', value: 'money' },
    ]);
    assert.equal(menu.options[0].description, '33 Golds per product');
    assert.equal(menu.options[1].description, 'Money · $2.00 per product');
    assert.match(token, /^[a-f0-9]{32}$/);
    assert.ok(menu.custom_id.length <= 100);
    const session = getListingRequest(token, { guildId: f.guildId, buyerDiscordId: f.buyer.id });
    assert.equal(session.seller_discord_id, f.seller.id);
    assert.equal(session.message_id, f.messageId);
    assert.equal(session.expires_at - session.created_at, 15 * 60 * 1000);
});

test('a Money-only post exposes no game methods and rejects forged omitted options at both stages', async () => {
    const f = fixture('Item: Menace Cape\nMoney: $2.00');
    const { menu, token } = await f.open();
    assert.deepEqual(menu.options.map(option => option.value), ['money']);
    const reads = f.calls.reads;
    await selection.execute(f.choose(token, 'golds'));
    await offerModal.execute(f.modal(token, 'redblocks', '2'));
    assert.match(responseContent(f.calls), /payment method offered/);
    assert.equal(f.calls.reads, reads);
    assert.equal(f.calls.modal.length, 0);
    assertNoDeal(f);
});

test('every advertised method opens a quantity-only form without source REST work', async () => {
    const f = fixture();
    const { token } = await f.open();
    const reads = f.calls.reads;
    const channelFetches = f.calls.channelFetches;
    f.guild.channels.fetch = async () => { assert.fail('A selection must show its modal before source REST lookups'); };
    for (const method of ['money', 'golds', 'redblocks', 'sky1notchs']) {
        await selection.execute(f.choose(token, method));
        const modal = f.calls.modal.at(-1);
        assert.equal(modal.custom_id, `deal_offer_modal_v2_${token}_${method}`);
        assert.ok(modal.custom_id.length <= 100);
        assert.equal(modal.components.length, 1);
        assert.equal(modal.components[0].components[0].custom_id, 'quantity');
        assert.equal(modal.components[0].components[0].value, '1');
        assert.equal(modal.components[0].components[0].required, true);
    }
    assert.equal(f.calls.reads, reads);
    assert.equal(f.calls.channelFetches, channelFetches);
    assert.equal(f.calls.membership, 0);
});

test('buyer and server bindings reject both menu and modal before source reads', async () => {
    const f = fixture();
    const { token } = await f.open();
    const reads = f.calls.reads;
    for (const overrides of [{ user: { ...f.buyer, id: id() } }, { guildId: id() }]) {
        await selection.execute(f.choose(token, 'money', overrides));
        const input = f.modal(token, 'money', '1', overrides);
        await offerModal.execute(input);
        assert.equal(input.deferred, false);
    }
    assert.equal(f.calls.modal.length, 0);
    assert.equal(f.calls.reads, reads);
    assert.match(responseContent(f.calls), /expired|no longer available/);
    assertNoDeal(f);
});

test('legacy manual-amount menus and forms expire instead of bypassing fixed prices', async () => {
    const f = fixture();
    await selection.execute(f.interaction({ customId: `deal_payment_method_${f.sourceId}_${f.messageId}_${f.buyer.id}` }));
    await offerModal.execute(f.interaction({ customId: `deal_offer_modal_money_${f.sourceId}_${f.messageId}_${f.buyer.id}`,
        fields: { getTextInputValue: () => assert.fail('Legacy price fields must never be read') } }));
    assert.match(responseContent(f.calls), /expired.*Reopen Request a Deal/);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.modal.length, 0);
    assertNoDeal(f);
});

test('a malformed, multi-value, or unsupported payment selection cannot open a form', async () => {
    const f = fixture();
    const { token } = await f.open();
    for (const values of [[], ['money', 'golds'], ['other-currency']]) {
        await selection.execute(f.choose(token, 'money', { values }));
    }
    await selection.execute(f.choose('not-a-valid-token'));
    assert.equal(f.calls.modal.length, 0);
    assertNoDeal(f);
});

test('malformed product quantities are rejected before reading the source', async () => {
    const f = fixture();
    const { token } = await f.open();
    const reads = f.calls.reads;
    for (const quantity of ['', '0', '-1', '1.5', '2garbage', '1e2', '1000', '01']) {
        const input = f.modal(token, 'golds', quantity);
        await offerModal.execute(input);
        assert.equal(input.deferred, false, quantity);
    }
    assert.equal(f.calls.reads, reads);
    assert.match(responseContent(f.calls), /whole product quantity from 1 to 999/);
    assertNoDeal(f);
});

test('submitted form rechecks source access and private-thread membership before reading prices', async () => {
    const f = fixture();
    const { token } = await f.open();
    const reads = f.calls.reads;
    f.source.permissionsFor = () => new PermissionsBitField();
    const inaccessible = f.modal(token);
    await offerModal.execute(inaccessible);
    assert.equal(inaccessible.deferred, true);
    assert.match(responseContent(f.calls), /no longer access/);
    assert.equal(f.calls.reads, reads);
    f.source.type = ChannelType.PrivateThread;
    f.source.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
    f.source.members.fetch = async () => { f.calls.membership++; return null; };
    const notMember = f.modal(token);
    await offerModal.execute(notMember);
    assert.equal(notMember.deferred, true);
    assert.match(responseContent(f.calls), /no longer a member/);
    assert.equal(f.calls.membership, 1);
    assert.equal(f.calls.reads, reads);
    assertNoDeal(f);
});

test('private-thread access is checked again after a valid payment selection', async () => {
    const f = fixture();
    f.source.type = ChannelType.PrivateThread;
    const { token } = await f.open();
    await selection.execute(f.choose(token, 'golds'));
    assert.equal(f.calls.modal.length, 1);
    const reads = f.calls.reads;
    f.source.members.fetch = async () => null;
    await offerModal.execute(f.modal(token, 'golds', '2'));
    assert.match(responseContent(f.calls), /no longer a member/);
    assert.equal(f.calls.reads, reads);
    assertNoDeal(f);
});

test('source channel, prices, and private membership bypass SDK caches at every check', async () => {
    const f = fixture('Item: Menace Cape\nGolds: 33');
    f.source.type = ChannelType.PrivateThread;
    // The context target is cached at 33; only a forced message fetch sees 44.
    const currentMessage = { ...f.targetMessage, content: 'Item: Menace Cape\nGolds: 44', editedTimestamp: Date.now() };
    f.source.messages.fetch = async options => {
        f.calls.reads++;
        f.calls.messageRequests.push(options);
        return options?.force === true && options?.cache === false ? currentMessage : f.targetMessage;
    };
    const { menu, token } = await f.open();
    assert.equal(menu.options[0].description, '44 Golds per product');
    await offerModal.execute(f.modal(token, 'golds', '2'));
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    assert.ok(row, responseContent(f.calls));
    assert.equal(row.amount, 88);
    assert.equal(f.calls.messageRequests.length, 3, 'Context, modal, and final creation all refresh prices');
    for (const options of f.calls.messageRequests) {
        assert.deepEqual(options, { message: f.messageId, force: true, cache: false });
    }
    assert.equal(f.calls.membershipRequests.length, 3);
    for (const options of f.calls.membershipRequests) {
        assert.deepEqual(options, { member: f.buyer.id, force: true, cache: false });
    }
    const sourceRequests = f.calls.channelRequests.filter(request => request.channelId === f.sourceId);
    assert.equal(sourceRequests.length, 3);
    for (const request of sourceRequests) assert.deepEqual(request.options, { force: true });
});

test('deleted, bot-owned, and identity-mismatched source messages cannot create a deal', async () => {
    const f = fixture();
    const { token } = await f.open();
    for (const message of [null, { ...f.targetMessage, author: { ...f.seller, bot: true } },
        { ...f.targetMessage, id: id() }, { ...f.targetMessage, channelId: id() }]) {
        f.source.messages.fetch = async () => message;
        await offerModal.execute(f.modal(token));
        assertNoDeal(f);
    }
    assert.match(responseContent(f.calls), /source message could not be found/);
    assert.match(responseContent(f.calls), /bot message/);
});

test('editing price, product, or edit timestamp invalidates an open price menu', async () => {
    for (const change of [
        f => { f.targetMessage.content = 'Item: Menace Cape\nGolds: 34'; },
        f => { f.targetMessage.content = 'Item: Another Cape\nGolds: 33'; },
        f => { f.targetMessage.editedTimestamp = Date.now(); },
    ]) {
        const f = fixture('Item: Menace Cape\nGolds: 33');
        const { token } = await f.open();
        change(f);
        await offerModal.execute(f.modal(token, 'golds', '2'));
        assert.match(responseContent(f.calls), /changed.*Reopen Request a Deal/);
        assertNoDeal(f);
    }
});

test('a source edit during hub preparation is caught by the final source recheck', async () => {
    const f = fixture('Item: Menace Cape\nGolds: 33');
    const { token } = await f.open();
    f.guild.members.fetchMe = async () => {
        f.targetMessage.content = 'Item: Menace Cape\nGolds: 99';
        return { id: id() };
    };
    await offerModal.execute(f.modal(token, 'golds', '2'));
    assert.match(responseContent(f.calls), /edited.*Reopen Request a Deal/);
    assertNoDeal(f);
});

test('expired pickers and forms cannot create an offer', async () => {
    const f = fixture();
    const { token } = await f.open();
    const now = Date.now();
    db.prepare('UPDATE listing_request_sessions SET created_at = ?, expires_at = ? WHERE token = ?')
        .run(now - 16 * 60 * 1000, now - 1, token);
    const reads = f.calls.reads;
    await selection.execute(f.choose(token));
    await offerModal.execute(f.modal(token));
    assert.match(responseContent(f.calls), /expired/);
    assert.equal(f.calls.reads, reads);
    assert.equal(f.calls.modal.length, 0);
    assertNoDeal(f);
});

test('33 Golds times two products creates a fixed 66-Golds offer and records its provenance', async () => {
    const f = fixture('Item: Menace Cape\nGolds: 33');
    const { token } = await f.open();
    await offerModal.execute(f.modal(token, 'golds', '2'));
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    assert.ok(row, responseContent(f.calls));
    assert.equal(row.amount, 66);
    assert.equal(row.currency, 'Golds');
    assert.equal(row.payment_unit, 'each');
    assert.match(row.item_description, /Menace Cape\nQuantity: 2\nUnit price: 33 Golds/);
    assert.ok(row.item_description.includes(f.targetMessage.url));
    const terms = getEscrowListingTerms(row.id);
    assert.equal(terms.quantity, 2);
    assert.equal(terms.unit_amount, 33);
    assert.equal(terms.total_amount, 66);
    assert.equal(terms.method_key, 'golds');
    assert.equal(terms.message_id, f.messageId);
    assert.equal(terms.seller_discord_id, f.seller.id);
    assert.equal(f.calls.dm.length, 1);
    const payment = f.calls.dm[0].embeds[0].toJSON().fields.find(field => field.name === 'Agreed Payment');
    assert.equal(payment.value, '66 Golds');
    assert.match(responseContent(f.calls), /sent.*via DM/);
});

test('Money listing totals use the stored USD unit price and exact cents', async () => {
    const f = fixture('Item: Test Item\nMoney: $0.29');
    const { token } = await f.open();
    await offerModal.execute(f.modal(token, 'money', '3'));
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    assert.ok(row, responseContent(f.calls));
    assert.equal(row.amount, 0.87);
    assert.equal(row.currency, 'USD');
    assert.equal(row.payment_unit, 'each');
    const payment = f.calls.dm[0].embeds[0].toJSON().fields.find(field => field.name === 'Agreed Payment');
    assert.equal(payment.value, 'Money · $0.87');
});

test('stack prices multiply by product quantity without letting the buyer change the unit', async () => {
    const f = fixture('Item: Menace Cape\nRedblocks: 20 stacks');
    const { token } = await f.open();
    await offerModal.execute(f.modal(token, 'redblocks', '2'));
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    assert.ok(row, responseContent(f.calls));
    assert.equal(row.amount, 40);
    assert.equal(row.currency, 'Redblocks');
    assert.equal(row.payment_unit, 'stacks');
    const payment = f.calls.dm[0].embeds[0].toJSON().fields.find(field => field.name === 'Agreed Payment');
    assert.equal(payment.value, '40 stacks of Redblocks (2,560 blocks)');
    assert.equal(getEscrowListingTerms(row.id).quantity, 2);
});

test('a successfully submitted request cannot be replayed through either its modal or menu', async () => {
    const f = fixture('Item: Menace Cape\nGolds: 33');
    const { token } = await f.open();
    await offerModal.execute(f.modal(token, 'golds', '2'));
    assert.equal(dealCount(), 1);
    const reads = f.calls.reads;
    await offerModal.execute(f.modal(token, 'golds', '2'));
    await selection.execute(f.choose(token, 'golds'));
    assert.equal(dealCount(), 1);
    assert.equal(f.calls.dm.length, 1);
    assert.equal(f.calls.reads, reads);
    assert.match(responseContent(f.calls), /already been submitted.*\/deals/);
});

test('unclear, image-only, and embed-only prices receive a clear explanation without guessed offers', async () => {
    for (const content of ['', 'Menace Cape for 33 Golds', 'Item: Cape\nGolds: 33\nGolds: 44']) {
        const f = fixture(content);
        f.targetMessage.embeds = [{ title: 'Cape', description: 'Golds: 33' }];
        await contextCommand.execute(f.interaction());
        assert.match(responseContent(f.calls), /could not be identified safely/);
        assert.equal(f.calls.edit.at(-1).components?.length || 0, 0);
        assertNoDeal(f);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listing_request_sessions').get().count, 0);
});

test('the context command rejects self, bot, missing source, and DM requests', async () => {
    const f = fixture();
    for (const overrides of [
        { guildId: null }, { targetMessage: null },
        { targetMessage: { ...f.targetMessage, author: f.buyer } },
        { targetMessage: { ...f.targetMessage, author: { ...f.seller, bot: true } } },
    ]) {
        await contextCommand.execute(f.interaction(overrides));
    }
    assert.equal(f.calls.reply.length, 4);
    for (const payload of f.calls.reply) assert.equal(payload.ephemeral, true);
    assert.equal(f.calls.reads, 0);
    assertNoDeal(f);
});

test('context opening checks private source access before it can persist listing prices', async () => {
    const f = fixture();
    f.source.type = ChannelType.PrivateThread;
    f.source.members.fetch = async () => null;
    await contextCommand.execute(f.interaction());
    assert.match(responseContent(f.calls), /no longer a member/);
    assert.equal(f.calls.reads, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listing_request_sessions').get().count, 0);
});

test('source-thread parent permissions are refreshed before the first listing read', async () => {
    const f = fixture();
    const parentId = id();
    f.source.type = ChannelType.PublicThread;
    f.source.parentId = parentId;
    f.source.isThread = () => true;
    let cachedParentAllowsRead = true;
    f.source.permissionsFor = () => cachedParentAllowsRead
        ? new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
        : new PermissionsBitField();
    const originalFetch = f.guild.channels.fetch;
    const parentRequests = [];
    f.guild.channels.fetch = async (channelId, options) => {
        if (channelId !== parentId) return originalFetch(channelId, options);
        parentRequests.push(options);
        // ThreadChannel.permissionsFor delegates to this cached parent state.
        if (options?.force === true) cachedParentAllowsRead = false;
        return { id: parentId, guildId: f.guildId };
    };
    await contextCommand.execute(f.interaction());
    assert.deepEqual(parentRequests, [{ force: true }]);
    assert.equal(cachedParentAllowsRead, false);
    assert.match(responseContent(f.calls), /no longer access/);
    assert.equal(f.calls.reads, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listing_request_sessions').get().count, 0);
    assertNoDeal(f);
});

test('a failed source-thread parent refresh blocks a submitted request before reading prices', async () => {
    const f = fixture();
    const { token } = await f.open();
    const reads = f.calls.reads;
    const parentId = id();
    f.source.type = ChannelType.PublicThread;
    f.source.parentId = parentId;
    const originalFetch = f.guild.channels.fetch;
    const parentRequests = [];
    f.guild.channels.fetch = async (channelId, options) => {
        if (channelId !== parentId) return originalFetch(channelId, options);
        parentRequests.push(options);
        throw new Error('The thread parent can no longer be fetched');
    };
    await offerModal.execute(f.modal(token));
    assert.deepEqual(parentRequests, [{ force: true }]);
    assert.match(responseContent(f.calls), /no longer access/);
    assert.equal(f.calls.reads, reads);
    assertNoDeal(f);
});

test('select handlers route token controls without treating the listing token as an escrow ID', async () => {
    const client = { commands: new Map(), buttons: [], modals: [] };
    loadSelects(client);
    assert.ok(client.selects.some(handler => handler.id === 'deal_payment_method_'));
    const f = fixture();
    const { token } = await f.open();
    const input = f.choose(token, 'golds', { isStringSelectMenu: () => true, client });
    await router.execute(input, client);
    assert.equal(f.calls.modal.length, 1);
    assert.equal(router.processingDeals.size, 0);
    assert.equal(router.getActionEscrowId(input, selection), null);
});
