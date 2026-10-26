const { randomBytes } = require('node:crypto');
const { db } = require('./init');
const { parseListing, calculateListingPayment } = require('../utils/listings');
const { getPaymentMethod, resolvePayment, formatPayment } = require('../utils/payments');
const { boundedText } = require('../utils/validation');

const LISTING_REQUEST_TTL_MS = 15 * 60 * 1000;
const REOPEN_MESSAGE = 'This listing request has expired or is no longer available. Reopen Request a Deal on the seller\'s message.';

function invalid(message = REOPEN_MESSAGE) {
    const error = new Error(message);
    error.code = 'LISTING_REQUEST_INVALID';
    return error;
}

function timestamp(value = Date.now()) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - LISTING_REQUEST_TTL_MS) {
        throw invalid('The listing request timestamp is invalid.');
    }
    return value;
}

function identifier(value, name) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(value)) {
        throw invalid(`A valid ${name} is required for the listing request.`);
    }
    return value;
}

/** Rebuild canonical prices so callers cannot store inconsistent currencies or units. */
function normalizeListing(listing) {
    if (!listing || typeof listing.item !== 'string' || /[\r\n]/.test(listing.item) || !Array.isArray(listing.options) ||
        listing.options.length < 1 || listing.options.length > 4) {
        throw invalid('The seller listing is invalid. Open a new request from a supported listing.');
    }
    const lines = [`Item: ${listing.item}`];
    for (const option of listing.options) {
        const method = getPaymentMethod(option?.key);
        if (!method) throw invalid('The listing contains an unsupported payment method.');
        const payment = resolvePayment({ method: method.key, amount: option.amount, unit: option.paymentUnit });
        if (option.currency !== payment.currency) throw invalid('The listing currency does not match its payment method.');
        lines.push(`${method.label}: ${payment.amount}${payment.paymentUnit === 'stacks' ? ' stacks' : ''}`);
    }
    return parseListing(lines.join('\n'));
}

/** Legacy single-item snapshots keep their original JSON and prices. */
function catalogFromSnapshot(snapshot) {
    const { normalizeCatalog } = require('../utils/catalog');
    if (snapshot?.version === 2) return normalizeCatalog(snapshot);
    const listing = normalizeListing(snapshot);
    return normalizeCatalog({ version: 2, products: [{ id: 'p0', ...listing,
        bundleQuantity: 1, bundleUnit: null, stock: null }], warnings: [] });
}

/** A missing product is safe only when a snapshot contains exactly one item. */
function getSelectedProduct(catalog, productId) {
    if (!Array.isArray(catalog?.products) || !catalog.products.length) throw invalid();
    if (productId == null) {
        if (catalog.products.length !== 1) throw invalid('Choose a product or pack from this post before choosing payment.');
        return catalog.products[0];
    }
    const product = catalog.products.find(candidate => candidate.id === productId);
    if (!product) throw invalid('This product is not in the saved post. Reopen Request a Deal and choose an advertised product.');
    return product;
}

function hydrate(row) {
    if (!row) return undefined;
    let catalog;
    try { catalog = catalogFromSnapshot(JSON.parse(row.listing_json)); }
    catch { throw invalid(); }
    const product = catalog.products.length === 1 ? catalog.products[0] : null;
    const listing = product ? { item: product.item, options: product.options } : undefined;
    return { ...row, catalog, listing };
}

const insertRequest = db.transaction(params => {
    // Expired, unused forms carry no deal history. Remove a bounded batch while
    // retaining every consumed snapshot and its immutable escrow terms.
    db.prepare(`DELETE FROM listing_request_sessions WHERE token IN (
        SELECT token FROM listing_request_sessions
        WHERE consumed_escrow_id IS NULL AND expires_at <= ? LIMIT 1000
    )`).run(params.created_at);
    db.prepare(`INSERT INTO listing_request_sessions
        (token, guild_id, channel_id, message_id, buyer_discord_id, seller_discord_id,
         listing_json, source_fingerprint, source_content, created_at, expires_at)
        VALUES (@token, @guild_id, @channel_id, @message_id, @buyer_discord_id, @seller_discord_id,
            @listing_json, @source_fingerprint, @source_content, @created_at, @expires_at)`).run(params);
    return hydrate(db.prepare('SELECT * FROM listing_request_sessions WHERE token = ?').get(params.token));
});

function createListingRequest({ guildId, channelId, messageId, buyerDiscordId, sellerDiscordId,
    listing, catalog, sourceFingerprint, sourceContent = null, now = Date.now() } = {}) {
    const createdAt = timestamp(now);
    const identities = {
        guild_id: identifier(guildId, 'server ID'),
        channel_id: identifier(channelId, 'channel ID'),
        message_id: identifier(messageId, 'message ID'),
        buyer_discord_id: identifier(buyerDiscordId, 'buyer ID'),
        seller_discord_id: identifier(sellerDiscordId, 'seller ID'),
    };
    if (buyerDiscordId === sellerDiscordId) throw invalid('You cannot open a listing request with yourself.');
    if (typeof sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
        throw invalid('The source message fingerprint is invalid. Open a new request.');
    }
    if (sourceContent != null && (typeof sourceContent !== 'string' || sourceContent.length > 10000)) {
        throw invalid('The saved source text must contain no more than 10,000 characters.');
    }
    let snapshot;
    try {
        if (listing !== undefined && catalog !== undefined) throw invalid('Supply one saved listing or catalog, not both.');
        snapshot = catalog === undefined ? normalizeListing(listing) : catalogFromSnapshot(catalog);
    } catch (error) { throw invalid(error.message); }
    return insertRequest.immediate({ token: randomBytes(16).toString('hex'), ...identities,
        listing_json: JSON.stringify(snapshot), source_fingerprint: sourceFingerprint, source_content: sourceContent,
        created_at: createdAt, expires_at: createdAt + LISTING_REQUEST_TTL_MS });
}

function getListingRequest(token, { guildId, buyerDiscordId, now = Date.now() } = {}) {
    const at = timestamp(now);
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) throw invalid();
    if (!guildId || !buyerDiscordId) throw invalid('Open this listing request inside its original server.');
    const row = db.prepare('SELECT * FROM listing_request_sessions WHERE token = ?').get(token);
    if (!row || row.guild_id !== guildId || row.buyer_discord_id !== buyerDiscordId) throw invalid();
    if (row.consumed_escrow_id != null) throw invalid('This listing request has already been submitted. Use /deals to find your request.');
    if (row.expires_at <= at || row.created_at > at) throw invalid();
    return hydrate(row);
}

function getListingQuote(token, { guildId, buyerDiscordId, methodKey, quantity, productId, now = Date.now() } = {}) {
    const session = getListingRequest(token, { guildId, buyerDiscordId, now });
    const product = getSelectedProduct(session.catalog, productId);
    if (product.stock === 0) throw invalid('This product is listed as out of stock. Choose another product or ask the seller to update the post.');
    let payment;
    try { payment = calculateListingPayment(product, methodKey, quantity); }
    catch (error) { throw invalid(error.message); }
    const unitPayment = formatPayment({ amount: payment.unitAmount, currency: payment.currency,
        paymentUnit: payment.paymentUnit });
    const sourceUrl = `https://discord.com/channels/${session.guild_id}/${session.channel_id}/${session.message_id}`;
    // Keep the unit price, quantity and source visible even for a long item name.
    const bundleLines = product.bundleQuantity > 1
        ? ` packs\nPack size: ${product.bundleQuantity} ${product.bundleUnit || 'items'}\nTotal items: ${product.bundleQuantity * payment.quantity} ${product.bundleUnit || 'items'}`
        : '';
    const itemDescription = `${boundedText(product.item, 600)}\nQuantity: ${payment.quantity}${bundleLines}\nUnit price: ${unitPayment}\nSource: ${sourceUrl}`;
    const listing = { item: product.item, options: product.options };
    return { session, catalog: session.catalog, product, listing, payment, itemDescription };
}

const consumeRequest = db.transaction((escrowId, options) => {
    const quote = getListingQuote(options.token, options);
    const { session, payment, product, itemDescription } = quote;
    if (session.seller_discord_id !== options.sellerDiscordId ||
        payment.amount !== options.amount || payment.currency !== options.currency ||
        payment.paymentUnit !== options.paymentUnit) {
        throw invalid('The listing payment does not match the seller\'s price. Open a new request.');
    }
    const escrow = db.prepare(`SELECT e.*, buyer.discord_id AS buyer_discord_id,
        seller.discord_id AS seller_discord_id FROM escrow_transactions e
        JOIN users buyer ON buyer.id = e.buyer_id JOIN users seller ON seller.id = e.seller_id
        WHERE e.id = ?`).get(escrowId);
    if (!escrow || escrow.guild_id !== session.guild_id || escrow.buyer_discord_id !== session.buyer_discord_id ||
        escrow.seller_discord_id !== session.seller_discord_id || escrow.status !== 'pending' ||
        escrow.amount !== payment.amount || escrow.currency !== payment.currency ||
        escrow.payment_unit !== payment.paymentUnit || escrow.item_description !== itemDescription) {
        throw invalid('The deal does not match the approved listing request. Open a new request.');
    }
    const consumed = db.prepare(`UPDATE listing_request_sessions SET consumed_escrow_id = ?
        WHERE token = ? AND consumed_escrow_id IS NULL AND expires_at > ?`).run(escrow.id, session.token, options.now ?? Date.now());
    if (!consumed.changes) throw invalid();
    db.prepare(`INSERT INTO escrow_listing_terms
        (escrow_id, guild_id, channel_id, message_id, buyer_discord_id, seller_discord_id, item,
         quantity, method_key, unit_amount, payment_unit, total_amount, currency, listing_json, source_fingerprint,
         source_content, product_key, bundle_quantity, bundle_unit, advertised_stock)
        VALUES (@escrow_id, @guild_id, @channel_id, @message_id, @buyer_discord_id, @seller_discord_id, @item,
            @quantity, @method_key, @unit_amount, @payment_unit, @total_amount, @currency, @listing_json, @source_fingerprint,
            @source_content, @product_key, @bundle_quantity, @bundle_unit, @advertised_stock)`)
        .run({ escrow_id: escrow.id, guild_id: session.guild_id, channel_id: session.channel_id, message_id: session.message_id,
            buyer_discord_id: session.buyer_discord_id, seller_discord_id: session.seller_discord_id, item: product.item,
            quantity: payment.quantity, method_key: options.methodKey, unit_amount: payment.unitAmount,
            payment_unit: payment.paymentUnit, total_amount: payment.amount, currency: payment.currency,
            listing_json: session.listing_json, source_fingerprint: session.source_fingerprint, source_content: session.source_content,
            product_key: product.id, bundle_quantity: product.bundleQuantity,
            bundle_unit: product.bundleUnit, advertised_stock: product.stock });
    return getEscrowListingTerms(escrow.id);
});

/** Nested transactions use SQLite savepoints; the outer escrow INSERT rolls back on failure. */
function consumeListingRequest(escrowId, options = {}) {
    return consumeRequest.immediate(escrowId, options);
}

function getEscrowListingTerms(escrowId) {
    return db.prepare('SELECT * FROM escrow_listing_terms WHERE escrow_id = ?').get(escrowId);
}

module.exports = { LISTING_REQUEST_TTL_MS, createListingRequest, getListingRequest, getListingQuote,
    consumeListingRequest, getEscrowListingTerms, getSelectedProduct };
