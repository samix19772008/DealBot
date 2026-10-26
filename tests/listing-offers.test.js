process.env.DATABASE_PATH = ':memory:';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { setHubChannel } = require('../src/database/guildSettingsRepository');
const { createListingRequest, getEscrowListingTerms } = require('../src/database/listingRepository');
const { parseListing, listingFingerprint } = require('../src/utils/listings');
const { parseCatalog } = require('../src/utils/catalog');
const { sendDealOffer, REQUIRED_HUB_PERMISSIONS } = require('../src/utils/dealOffer');

let sequence = 0;
const nextId = () => String(900000000000000000n + BigInt(++sequence));
after(() => db.close());

function fixture(content = 'Item: Menace Cape\nGolds: 33', methodKey = 'golds', quantity = 2, { catalog, productId } = {}) {
    const guildId = nextId();
    const sent = { dm: [], replies: [] };
    const buyer = { id: nextId(), tag: 'Buyer', createdAt: new Date('2020-01-01'), bot: false };
    const seller = { id: nextId(), tag: 'Seller', createdAt: new Date('2020-01-01'), bot: false,
        send: async payload => { sent.dm.push(payload); } };
    const member = { id: buyer.id };
    const message = { id: nextId(), channelId: nextId(), guildId, author: seller, content, editedTimestamp: null };
    const source = { id: message.channelId, guildId, type: ChannelType.GuildText, isTextBased: () => true,
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]),
        messages: { fetch: async options => {
            assert.deepEqual(options, { message: message.id, force: true, cache: false });
            return message;
        } } };
    const bot = { id: nextId() };
    const hub = { id: nextId(), type: ChannelType.GuildText,
        permissionsFor: () => new PermissionsBitField(REQUIRED_HUB_PERMISSIONS) };
    const guild = { id: guildId, name: 'Listing Test Server',
        channels: { fetch: async channelId => channelId === hub.id ? hub : source },
        members: { fetch: async userId => ({ id: userId }), fetchMe: async () => bot } };
    const interaction = { guildId, guild, user: buyer, member, deferred: true,
        editReply: async payload => { sent.replies.push(payload); } };
    const session = createListingRequest({ guildId, channelId: message.channelId, messageId: message.id,
        buyerDiscordId: buyer.id, sellerDiscordId: seller.id,
        ...(catalog ? { catalog } : { listing: parseListing(content) }), sourceFingerprint: listingFingerprint(message) });
    setHubChannel(guildId, hub.id);
    return { interaction, sellerDiscordUser: seller, listingRequest: { token: session.token, productId, methodKey, quantity },
        // Injected caller values must never replace the stored seller terms.
        itemDescription: 'Forged item', amount: 1, currency: 'USD', paymentUnit: 'stacks',
        sent, message, source, session, hub };
}

function storedDeals(f) {
    return db.prepare('SELECT * FROM escrow_transactions WHERE guild_id = ?').all(f.interaction.guildId);
}

test('offer delivery recomputes seller prices and descriptions instead of trusting caller amounts', async () => {
    for (const [content, method, quantity, amount, currency, unit] of [
        ['Item: Cape\nGolds: 33', 'golds', 2, 66, 'Golds', 'each'],
        ['Item: Cape\nMoney: $0.29', 'money', 3, 0.87, 'USD', 'each'],
        ['Item: Cape\nRedblocks: 20 stacks', 'redblocks', 2, 40, 'Redblocks', 'stacks'],
        ['Item: Cape\nSky 1 Notchs: 20', 'sky1notchs', 2, 40, 'Sky 1 Notchs', 'each'],
    ]) {
        const f = fixture(content, method, quantity);
        await sendDealOffer(f);
        const [deal] = storedDeals(f);
        assert.ok(deal, JSON.stringify(f.sent.replies));
        assert.equal(deal.amount, amount);
        assert.equal(deal.currency, currency);
        assert.equal(deal.payment_unit, unit);
        assert.match(deal.item_description, new RegExp(`Quantity: ${quantity}`));
        assert.match(deal.item_description, /Unit price:/);
        assert.doesNotMatch(deal.item_description, /Forged item/);
        const terms = getEscrowListingTerms(deal.id);
        assert.equal(terms.quantity, quantity);
        assert.equal(terms.total_amount, amount);
        assert.equal(terms.source_fingerprint, f.session.source_fingerprint);
        assert.equal(f.sent.dm.length, 1);
        assert.equal(db.prepare('SELECT consumed_escrow_id FROM listing_request_sessions WHERE token = ?')
            .get(f.session.token).consumed_escrow_id, deal.id);
        await sendDealOffer(f);
        assert.equal(storedDeals(f).length, 1);
        assert.equal(f.sent.dm.length, 1);
        assert.match(f.sent.replies.at(-1).content, /already been submitted/);
    }
});

test('the final offer check detects a listing edit during asynchronous hub lookups', async () => {
    const f = fixture();
    f.interaction.guild.members.fetchMe = async () => {
        f.message.content = 'Item: Menace Cape\nGolds: 99';
        f.message.editedTimestamp = Date.now();
        return { id: nextId() };
    };
    await sendDealOffer(f);
    assert.equal(storedDeals(f).length, 0);
    assert.equal(f.sent.dm.length, 0);
    assert.match(f.sent.replies.at(-1).content, /edited this listing.*Reopen/);
});

test('a deleted source at the final check cannot produce a request from its earlier snapshot', async () => {
    const f = fixture();
    f.source.messages.fetch = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
    await sendDealOffer(f);
    assert.equal(storedDeals(f).length, 0);
    assert.equal(f.sent.dm.length, 0);
    assert.match(f.sent.replies.at(-1).content, /source message could not be found/);
});

test('expiry during Discord lookups is enforced by the final transaction without a partial deal', async () => {
    const f = fixture();
    f.interaction.guild.members.fetchMe = async () => {
        db.prepare('UPDATE listing_request_sessions SET expires_at = ? WHERE token = ?')
            .run(Date.now() - 1, f.session.token);
        return { id: nextId() };
    };
    // Keep created_at earlier than the simulated boundary to preserve the schema check.
    db.prepare('UPDATE listing_request_sessions SET created_at = created_at - 10000 WHERE token = ?').run(f.session.token);
    await sendDealOffer(f);
    assert.equal(storedDeals(f).length, 0);
    assert.equal(f.sent.dm.length, 0);
    assert.equal(db.prepare('SELECT consumed_escrow_id FROM listing_request_sessions WHERE token = ?')
        .get(f.session.token).consumed_escrow_id, null);
    assert.match(f.sent.replies.at(-1).content, /expired/);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('the offer service derives prices from the selected catalog product rather than caller payment fields', async () => {
    const content = require('./fixtures/market-posts.json').ranks;
    const catalog = parseCatalog(content);
    const product = catalog.products.find(candidate => /Emerald/i.test(candidate.item));
    assert.ok(product);
    const f = fixture(content, 'golds', 2, { catalog, productId: product.id });
    // The shared fixture injects an unrelated item, amount1, USD and stack unit.
    await sendDealOffer(f);
    const [deal] = storedDeals(f);
    assert.ok(deal, JSON.stringify(f.sent.replies));
    assert.equal(deal.amount, 168);
    assert.equal(deal.currency, 'Golds');
    assert.equal(deal.payment_unit, 'each');
    assert.match(deal.item_description, /Emerald/i);
    assert.doesNotMatch(deal.item_description, /Special|Forged item/i);
    const terms = getEscrowListingTerms(deal.id);
    assert.equal(terms.product_key, product.id);
    assert.equal(terms.unit_amount, 84);
    assert.equal(terms.quantity, 2);
    assert.equal(terms.total_amount, 168);
    assert.equal(f.sent.dm.length, 1);
});
