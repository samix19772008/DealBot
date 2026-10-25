const { createHash } = require('node:crypto');
const { PAYMENT_METHODS, resolvePayment } = require('./payments');

const MAX_LISTING_QUANTITY = 999;
const LISTING_TEMPLATE = [
    'Item: Menace Cape',
    'Money: $2.00',
    'Golds: 33',
    'Redblocks: 20 stacks',
    'Sky 1 Notchs: 20',
].join('\n');
const LISTING_FORMAT_HELP = [
    'Ask the seller to use /listing-format and edit their post to match the listing format.',
    'Use one Item line and one or more price lines. Keep only the payment methods the seller accepts.',
    'Each price is for ONE product. Game prices must be whole items or stacks of 64; Money is USD.',
].join(' ');

function listingError(message) {
    return new Error(`${message} ${LISTING_FORMAT_HELP}`);
}

/** Only seller-authored message text supplies prices, never attachment or embed guesses. */
function getListingText(message) {
    return typeof message?.content === 'string' ? message.content : '';
}

/** Parse one whole, explicit listing. Unrecognized lines must not silently become prices. */
function parseListing(messageContent) {
    let text = typeof messageContent === 'string' ? messageContent.trim() : '';
    if (!text) throw listingError('This post needs a text listing; prices cannot be read from an image alone.');
    if (text.length > 4000) throw listingError('The listing text must not exceed 4,000 characters.');
    if (text.startsWith('```')) {
        const fenced = text.match(/^```(?:deal|text|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
        if (!fenced) throw listingError('Wrap the complete listing in one plain, text, or deal code block.');
        text = fenced[1].trim();
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f`]/.test(text)) {
        throw listingError('The listing contains unsupported formatting or control characters.');
    }

    let item;
    const options = [];
    const seen = new Set();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const entry = line.match(/^([^:]+):\s*(.*?)\s*$/);
        if (!entry) throw listingError('Every listing line must use Label: value.');
        const label = entry[1].trim().toLowerCase();
        if (seen.has(label)) throw listingError('Each listing label may appear only once.');
        seen.add(label);
        if (label === 'item') {
            item = entry[2];
            if (!item || item.length > 200 || /[\x00-\x1f\x7f<>@`]/.test(item)) {
                throw listingError('Use an Item name of 1 to 200 characters without mentions or special formatting.');
            }
            continue;
        }
        const method = PAYMENT_METHODS.find(candidate => candidate.label.toLowerCase() === label);
        if (!method) throw listingError('Allowed labels are Item, Money, Golds, Redblocks, and Sky 1 Notchs.');

        const price = method.key === 'money'
            ? entry[2].match(/^\$?(\d+(?:\.\d{1,2})?)$/)
            : entry[2].match(/^(\d+)(?:[ \t]+(each|stack|stacks))?$/i);
        if (!price) {
            throw listingError(method.key === 'money'
                ? 'Use a USD price such as Money: $2.00, with at most two decimal places.'
                : `Use a whole price such as ${method.label}: 33 or ${method.label}: 2 stacks.`);
        }
        let payment;
        try { payment = resolvePayment({ method: method.key, amount: price[1], unit: price[2] || 'each' }); }
        catch (error) { throw listingError(`${method.label}: ${error.message}`); }
        options.push({ key: method.key, label: method.label, ...payment });
    }
    if (!item) throw listingError('The post must contain exactly one Item: product name line.');
    if (!options.length) throw listingError('The post must contain at least one supported payment price.');
    return { item, options };
}

/** Quantities multiply a saved seller price; buyers cannot provide a replacement amount. */
function calculateListingPayment(listing, methodKey, quantity) {
    const quantityText = String(quantity ?? '').trim();
    if (!/^[1-9]\d{0,2}$/.test(quantityText)) {
        throw new Error(`Choose a whole product quantity from 1 to ${MAX_LISTING_QUANTITY}.`);
    }
    const count = Number(quantityText);
    const matches = Array.isArray(listing?.options)
        ? listing.options.filter(option => option.key === methodKey)
        : [];
    if (matches.length !== 1) throw new Error('Choose a payment method offered in this listing.');
    const option = matches[0];
    const unitPrice = resolvePayment({ method: methodKey, amount: option.amount, unit: option.paymentUnit });
    let amount;
    if (methodKey === 'money') {
        const cents = Number(unitPrice.amount.toFixed(2).replace('.', ''));
        const totalCents = cents * count;
        if (!Number.isSafeInteger(totalCents)) throw new Error('This quantity exceeds the supported payment limit.');
        amount = `${Math.floor(totalCents / 100)}.${String(totalCents % 100).padStart(2, '0')}`;
    } else {
        amount = unitPrice.amount * count;
    }
    const payment = resolvePayment({ method: methodKey, amount, unit: unitPrice.paymentUnit });
    return { ...payment, quantity: count, unitAmount: unitPrice.amount };
}

/** Include message identity and edit state so stale price menus cannot create an offer. */
function listingFingerprint(message) {
    return createHash('sha256').update(JSON.stringify({
        authorId: message?.author?.id ?? null,
        channelId: message?.channelId ?? null,
        messageId: message?.id ?? null,
        content: getListingText(message),
        editedTimestamp: message?.editedTimestamp ?? null,
    })).digest('hex');
}

module.exports = {
    MAX_LISTING_QUANTITY,
    LISTING_TEMPLATE,
    LISTING_FORMAT_HELP,
    getListingText,
    parseListing,
    calculateListingPayment,
    listingFingerprint,
};
