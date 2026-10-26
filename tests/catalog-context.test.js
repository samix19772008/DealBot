process.env.DATABASE_PATH = ':memory:';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { setHubChannel } = require('../src/database/guildSettingsRepository');
const { createListingRequest, getListingRequest, getEscrowListingTerms } = require('../src/database/listingRepository');
const { listingFingerprint } = require('../src/utils/listings');
const { createCatalogResponse } = require('../src/utils/catalogPresentation');
const context = require('../src/commands/context/dealOnMessage');
const productSelection = require('../src/interactions/selects/dealProduct');
const paymentSelection = require('../src/interactions/selects/paymentMethod');
const offerModal = require('../src/interactions/modals/dealOfferModal');
const { REQUIRED_HUB_PERMISSIONS } = require('../src/utils/dealOffer');
const router = require('../src/events/interactionCreate');
const posts = require('./fixtures/market-posts.json');

let sequence = 0;
const id = () => String(910000000000000000n + BigInt(++sequence));
beforeEach(() => {
    db.exec('DELETE FROM listing_request_sessions; DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings; DELETE FROM offer_cooldowns;');
    router.processingDeals.clear();
});
after(() => db.close());

const menuIn = payload => payload?.components?.[0]?.toJSON().components[0];
function fixture(content = posts.ranks) {
    const calls = { replies: [], edits: [], updates: [], modals: [], dm: [], reads: 0, channels: 0 };
    const guildId = id();
    const buyer = { id: id(), tag: 'Buyer', bot: false, createdAt: new Date('2020-01-01') };
    const seller = { id: id(), tag: 'Seller', bot: false, createdAt: new Date('2020-01-01'),
        send: async payload => calls.dm.push(payload) };
    const sourceId = id();
    const message = { id: id(), channelId: sourceId, guildId, author: seller, content, editedTimestamp: null };
    const member = { id: buyer.id };
    const source = { id: sourceId, guildId, type: ChannelType.GuildText, isTextBased: () => true,
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]),
        messages: { fetch: async options => {
            assert.deepEqual(options, { message: message.id, force: true, cache: false });
            calls.reads++;
            return message;
        } } };
    const hub = { id: id(), type: ChannelType.GuildText,
        permissionsFor: () => new PermissionsBitField(REQUIRED_HUB_PERMISSIONS) };
    const guild = { id: guildId, name: 'Market',
        members: { fetch: async userId => ({ id: userId }), fetchMe: async () => ({ id: id() }) },
        channels: { fetch: async channelId => {
            calls.channels++;
            return channelId === sourceId ? source : channelId === hub.id ? hub : null;
        } } };
    setHubChannel(guildId, hub.id);
    function input(overrides = {}) {
        return { guildId, guild, member, user: buyer, channelId: sourceId, targetMessage: message,
            deferred: false, replied: false,
            reply: async function (payload) { this.replied = true; calls.replies.push(payload); },
            followUp: async payload => calls.replies.push(payload),
            editReply: async payload => calls.edits.push(payload),
            update: async function (payload) { this.replied = true; calls.updates.push(payload); },
            deferReply: async function (payload) { this.deferred = true; assert.equal(payload.ephemeral, true); },
            showModal: async modal => calls.modals.push(modal.toJSON()),
            isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
            isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false,
            ...overrides };
    }
    async function open() {
        await context.execute(input());
        const menu = menuIn(calls.edits.at(-1));
        assert.ok(menu, JSON.stringify(calls.edits));
        const match = menu.custom_id.match(/^deal_product_v3_([a-f0-9]{32})_\d+$/);
        assert.ok(match, menu.custom_id);
        const token = match[1];
        return { token, menu, session: getListingRequest(token, { guildId, buyerDiscordId: buyer.id }) };
    }
    function chooseProduct(token, productId, page = 0, overrides = {}) {
        return input({ customId: `deal_product_v3_${token}_${page}`, values: [productId], ...overrides });
    }
    function choosePayment(token, productId, method = 'sky1notchs', overrides = {}) {
        return input({ customId: `deal_payment_method_v3_${token}_${productId}`, values: [method], ...overrides });
    }
    function modal(token, productId, method = 'sky1notchs', quantity = '1', overrides = {}) {
        return input({ customId: `deal_offer_modal_v3_${token}_${productId}_${method}`,
            fields: { getTextInputValue: name => {
                assert.equal(name, 'quantity', 'A catalog request must never accept buyer-entered payment amounts');
                return quantity;
            } }, ...overrides });
    }
    const deals = () => db.prepare('SELECT * FROM escrow_transactions WHERE guild_id = ?').all(guildId);
    const allText = () => [...calls.replies, ...calls.edits, ...calls.updates].map(payload => payload.content || '').join('\n');
    return { calls, guildId, buyer, seller, message, source, guild, input, open, chooseProduct, choosePayment, modal, deals, allText };
}

function findProduct(session, pattern, predicate = () => true) {
    const matches = session.catalog.products.filter(product => pattern.test(product.item) && predicate(product));
    assert.equal(matches.length, 1, JSON.stringify(session.catalog.products.map(product => ({ item: product.item, bundleQuantity: product.bundleQuantity }))));
    return matches[0];
}

test('a decorated rank post creates separate choices and preserves each rank price through delivery', async () => {
    for (const [name, method, quantity, expectedAmount, expectedCurrency] of [
        [/Emerald/i, 'money', '2', 11, 'USD'],
        [/Emerald/i, 'golds', '2', 168, 'Golds'],
        [/Special/i, 'golds', '1', 352, 'Golds'],
        [/Special/i, 'sky1notchs', '1', 144, 'Sky 1 Notchs'],
    ]) {
        const f = fixture();
        const { token, menu, session } = await f.open();
        assert.equal(menu.options.length, 2);
        const product = findProduct(session, name);
        const reads = f.calls.reads;
        await productSelection.execute(f.chooseProduct(token, product.id));
        const paymentMenu = menuIn(f.calls.updates.at(-1));
        assert.equal(paymentMenu.custom_id, `deal_payment_method_v3_${token}_${product.id}`);
        assert.deepEqual(paymentMenu.options.map(option => option.value), ['money', 'golds', 'redblocks', 'sky1notchs']);
        await paymentSelection.execute(f.choosePayment(token, product.id, method));
        assert.equal(f.calls.reads, reads, 'Selecting an item or payment must not delay the quantity modal with REST');
        assert.equal(f.calls.modals.at(-1).custom_id, `deal_offer_modal_v3_${token}_${product.id}_${method}`);
        await offerModal.execute(f.modal(token, product.id, method, quantity));
        const [deal] = f.deals();
        assert.ok(deal, f.allText());
        assert.equal(deal.amount, expectedAmount);
        assert.equal(deal.currency, expectedCurrency);
        assert.equal(deal.payment_unit, 'each');
        assert.match(deal.item_description, name);
        const terms = getEscrowListingTerms(deal.id);
        assert.equal(terms.product_key, product.id);
        assert.equal(terms.source_content, f.message.content);
        assert.equal(terms.quantity, Number(quantity));
        assert.equal(terms.total_amount, expectedAmount);
        assert.equal(f.calls.dm.length, 1);
        for (const payload of [...f.calls.edits, ...f.calls.updates, ...f.calls.dm]) {
            if (payload.components?.length || payload.embeds?.length) {
                assert.deepEqual(payload.allowedMentions, { parse: [] });
            }
        }
        assert.doesNotMatch(f.allText(), /@everyone/);
    }
});

test('different offers in a decorated stock post keep their own bundles, currencies and prices', async () => {
    const f = fixture(posts.skypvp);
    const { token, session } = await f.open();
    const product = findProduct(session, /Unbreaking II\b/i, candidate => candidate.bundleQuantity === 9);
    assert.equal(product.stock, 26);
    await productSelection.execute(f.chooseProduct(token, product.id));
    const paymentMenu = menuIn(f.calls.updates.at(-1));
    assert.deepEqual(paymentMenu.options.map(option => option.value), ['sky1notchs']);
    await paymentSelection.execute(f.choosePayment(token, product.id));
    const quantityField = f.calls.modals.at(-1).components[0].components[0];
    assert.match(quantityField.label, /pack/i);
    await offerModal.execute(f.modal(token, product.id, 'sky1notchs', '2'));
    const [deal] = f.deals();
    assert.ok(deal, f.allText());
    assert.equal(deal.amount, 10);
    assert.equal(deal.currency, 'Sky 1 Notchs');
    const terms = getEscrowListingTerms(deal.id);
    assert.equal(terms.quantity, 2);
    assert.equal(terms.bundle_quantity, 9);
    assert.equal(terms.unit_amount, 5);
    assert.equal(terms.total_amount, 10);
    assert.match(deal.item_description, /18/);
    assert.match(deal.item_description, /Books/i);
    assert.equal(f.calls.dm.length, 1);
});

test('bows, XP levels, and Golden Apple packs remain individually selectable in the same post', async () => {
    const f = fixture(posts.skypvp);
    const { session } = await f.open();
    const variants = [
        [/Punch II\b/i, null, 9], [/Punch I\b/i, null, 4],
        [/Experience|Xp/i, 90, 1], [/Experience|Xp/i, 180, 2],
        [/Golden Apple/i, 10, 1], [/Golden Apple/i, 24, 2],
    ];
    const seen = new Set();
    for (const [pattern, quantity, price] of variants) {
        const product = findProduct(session, pattern, candidate => quantity == null || candidate.bundleQuantity === quantity);
        assert.equal(product.options.length, 1);
        assert.equal(product.options[0].key, 'sky1notchs');
        assert.equal(product.options[0].amount, price);
        assert.equal(seen.has(product.id), false);
        seen.add(product.id);
    }
});

test('zero-stock bundles cannot be ordered through a product control or a forged quantity form', async () => {
    const f = fixture(posts.skypvp);
    const { token, session, menu } = await f.open();
    const soldOut = findProduct(session, /Unbreaking III\b/i, product => product.bundleQuantity === 3);
    assert.equal(soldOut.stock, 0);
    const displayed = menu.options.find(option => option.value === soldOut.id);
    assert.ok(displayed);
    assert.match(displayed.label + ' ' + displayed.description, /sold out|stock.*0/i);
    await productSelection.execute(f.chooseProduct(token, soldOut.id));
    await paymentSelection.execute(f.choosePayment(token, soldOut.id));
    await offerModal.execute(f.modal(token, soldOut.id));
    assert.match(f.allText(), /sold out|stock/i);
    assert.equal(f.calls.dm.length, 0);
    assert.equal(f.deals().length, 0);
    assert.equal(f.calls.modals.length, 0);
});

test('catalog controls reject foreign buyers, foreign servers, missing products, and omitted methods', async () => {
    const f = fixture(posts.skypvp);
    const { token, session } = await f.open();
    const product = findProduct(session, /Punch II\b/i);
    const reads = f.calls.reads;
    for (const overrides of [{ user: { ...f.buyer, id: id() } }, { guildId: id() }]) {
        await productSelection.execute(f.chooseProduct(token, product.id, 0, overrides));
        await paymentSelection.execute(f.choosePayment(token, product.id, 'sky1notchs', overrides));
        await offerModal.execute(f.modal(token, product.id, 'sky1notchs', '1', overrides));
    }
    for (const badProduct of ['p999', 'not-a-product']) {
        await productSelection.execute(f.chooseProduct(token, badProduct));
        await paymentSelection.execute(f.choosePayment(token, badProduct));
        await offerModal.execute(f.modal(token, badProduct));
    }
    await paymentSelection.execute(f.choosePayment(token, product.id, 'money'));
    await offerModal.execute(f.modal(token, product.id, 'money'));
    assert.equal(f.calls.reads, reads);
    assert.equal(f.calls.modals.length, 0);
    assert.equal(f.calls.dm.length, 0);
    assert.equal(f.deals().length, 0);
});

test('editing an advertised bundle invalidates a selected product before any offer can be sent', async () => {
    const f = fixture(posts.skypvp);
    const { token, session } = await f.open();
    const product = findProduct(session, /Punch II\b/i);
    await productSelection.execute(f.chooseProduct(token, product.id));
    f.message.content = f.message.content.replace('Punch II = 9', 'Punch II = 12');
    f.message.editedTimestamp = Date.now();
    await offerModal.execute(f.modal(token, product.id));
    assert.match(f.allText(), /changed.*Reopen|edited.*Reopen/);
    assert.equal(f.calls.dm.length, 0);
    assert.equal(f.deals().length, 0);
});

test('product-menu pagination exposes every stored product without exceeding Discord limits', async () => {
    const f = fixture();
    const products = Array.from({ length: 60 }, (_, index) => ({ id: `p${index}`, item: `Product ${index}`,
        options: [{ key: 'money', label: 'Money', amount: index + 1, currency: 'USD', paymentUnit: 'each' }],
        bundleQuantity: 1, bundleUnit: null, stock: null }));
    const session = createListingRequest({ guildId: f.guildId, channelId: f.message.channelId, messageId: f.message.id,
        buyerDiscordId: f.buyer.id, sellerDiscordId: f.seller.id,
        catalog: { version: 2, products, warnings: [] }, sourceFingerprint: listingFingerprint(f.message) });
    let menu = menuIn(createCatalogResponse(session));
    const exposed = [];
    for (let page = 0; page < 3; page++) {
        assert.equal(menu.custom_id, `deal_product_v3_${session.token}_${page}`);
        assert.ok(menu.custom_id.length <= 100);
        assert.ok(menu.options.length <= 25);
        for (const option of menu.options) {
            assert.ok(option.label.length <= 100);
            assert.ok((option.description || '').length <= 100);
            if (/^p\d+$/.test(option.value)) exposed.push(option.value);
        }
        if (page < 2) {
            const next = menu.options.find(option => option.value === `page:${page + 1}`);
            assert.ok(next, `Missing next-page control at page ${page}`);
            await productSelection.execute(f.chooseProduct(session.token, next.value, page));
            menu = menuIn(f.calls.updates.at(-1));
        }
    }
    assert.deepEqual(exposed, products.map(product => product.id));
    assert.equal(new Set(exposed).size, 60);
    await productSelection.execute(f.chooseProduct(session.token, 'p59', 2));
    const paymentMenu = menuIn(f.calls.updates.at(-1));
    assert.equal(paymentMenu.custom_id, `deal_payment_method_v3_${session.token}_p59`);
    assert.match(paymentMenu.options[0].description, /60\.00/);
    assert.equal(f.calls.reads, 0);
});

test('the interaction router dispatches product controls without interpreting a token as an escrow ID', async () => {
    const f = fixture();
    const { token, session } = await f.open();
    const client = { commands: new Map(), buttons: [], modals: [], selects: [productSelection, paymentSelection] };
    const product = findProduct(session, /Emerald/i);
    const input = f.chooseProduct(token, product.id, 0, { client, isStringSelectMenu: () => true });
    await router.execute(input, client);
    assert.equal(f.calls.updates.length, 1);
    assert.equal(router.getActionEscrowId(input, productSelection), null);
    assert.equal(router.processingDeals.size, 0);
});
