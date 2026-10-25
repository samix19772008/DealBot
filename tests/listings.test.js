const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_LISTING_QUANTITY, LISTING_TEMPLATE, LISTING_FORMAT_HELP,
    getListingText, parseListing, calculateListingPayment, listingFingerprint,
} = require('../src/utils/listings');

test('fixed listing format exposes only its explicitly offered payment alternatives', () => {
    const moneyOnly = parseListing('Item: Menace Cape\nMoney: $2.00');
    assert.equal(moneyOnly.item, 'Menace Cape');
    assert.deepEqual(moneyOnly.options, [
        { key: 'money', label: 'Money', amount: 2, currency: 'USD', paymentUnit: 'each' },
    ]);
    assert.throws(() => calculateListingPayment(moneyOnly, 'golds', 1), /offered in this listing/);
    assert.equal(parseListing(LISTING_TEMPLATE).options.length, 4);
    assert.match(LISTING_FORMAT_HELP, /ONE product/);
});

test('33 Golds per product fixes totals at 33, 66, and 99 without buyer-entered prices', () => {
    const listing = parseListing('Item: Menace Cape\nGolds: 33');
    for (const quantity of [1, 2, 3]) {
        assert.deepEqual(calculateListingPayment(listing, 'golds', quantity), {
            amount: 33 * quantity, currency: 'Golds', paymentUnit: 'each', quantity, unitAmount: 33,
        });
    }
});

test('listing Money calculations use integer cents for repeated decimal prices', () => {
    for (const [unitPrice, quantity, expected] of [
        ['0.10', 3, 0.3], ['0.29', 3, 0.87], ['2.55', 7, 17.85], ['0.01', 999, 9.99],
    ]) {
        const listing = parseListing(`Item: Product\nMoney: $${unitPrice}`);
        assert.equal(calculateListingPayment(listing, 'money', quantity).amount, expected);
    }
});

test('each and stacks remain separate payment units when product quantity changes', () => {
    const listing = parseListing(LISTING_TEMPLATE);
    assert.deepEqual(calculateListingPayment(listing, 'redblocks', '2'), {
        amount: 40, currency: 'Redblocks', paymentUnit: 'stacks', quantity: 2, unitAmount: 20,
    });
    assert.equal(calculateListingPayment(listing, 'sky1notchs', 2).amount, 40);
    assert.equal(calculateListingPayment(listing, 'sky1notchs', 2).paymentUnit, 'each');
    assert.equal(parseListing('Item: Product\nGolds: 1 stack').options[0].paymentUnit, 'stacks');
});

test('whole-message code fences, CRLF, blank lines, label case, and edge whitespace are supported', () => {
    for (const language of ['', 'deal', 'text', 'plaintext']) {
        const listing = parseListing(`  \`\`\`${language}\r\n ITEM : Cape\r\n\r\n gOlDs: 33 EACH \r\n\`\`\`  `);
        assert.equal(listing.item, 'Cape');
        assert.equal(listing.options[0].amount, 33);
        assert.equal(listing.options[0].paymentUnit, 'each');
    }
});

test('ambiguous, duplicate, unsupported, image-only, and incomplete listings are rejected', () => {
    const invalid = [
        '', null, undefined, 'Menace Cape\nGolds: 33', 'Item: Cape', 'Golds: 33',
        'Item: Cape\nItem: Other\nGolds: 33', 'Item: Cape\nGolds: 33\ngOlDs: 44',
        'Item: Cape\nUSD: 2', 'Item: Cape\nGolds: 33 or 44',
        'Item: Cape\nMoney: $2\nDM for more prices', 'Item: Cape\nOld Golds: 33',
        'Item: Cape\nGolds: 33\nStock: 10', 'Item: Cape\nGolds: 33\nBTC: 1',
        '```deal\nItem: Cape\nGolds: 33\n```\nMore prices',
        'Item: Cape\nGolds: 33\n```\nMoney: 5\n```',
    ];
    for (const content of invalid) {
        assert.throws(() => parseListing(content), /listing-format/, String(content));
    }
    const imageOnly = { content: '', embeds: [{ title: 'Item: Cape', description: 'Money: $2' }], attachments: [{ url: 'image.png' }] };
    assert.equal(getListingText(imageOnly), '');
    assert.throws(() => parseListing(getListingText(imageOnly)), /image alone/);
});

test('price syntax rejects decimals in game units, zero, negative, exponents, and mixed methods', () => {
    for (const line of [
        'Golds: 33.5', 'Golds: 33.00', 'Golds: 0', 'Golds: -33', 'Golds: 3e2',
        'Golds: 33 + Money: $2', 'Redblocks: 2 boxes', 'Redblocks: 0 stacks',
        'Money: 2.001', 'Money: -2', 'Money: 0', 'Money: 2 stacks', 'Money: 2 USD',
        'Money: 1,000', 'Money: NaN', 'Money: Infinity', 'Money: 10000000000',
    ]) {
        assert.throws(() => parseListing(`Item: Product\n${line}`), /listing-format/, line);
    }
});

test('product quantity must be an integer from 1 through 999', () => {
    assert.equal(MAX_LISTING_QUANTITY, 999);
    const listing = parseListing('Item: Cape\nGolds: 33');
    assert.equal(calculateListingPayment(listing, 'golds', '999').quantity, 999);
    assert.equal(calculateListingPayment(listing, 'golds', ' 2 ').amount, 66);
    for (const quantity of [0, -1, 1.5, 1000, '01', '1.0', '1e2', '2 Golds', '', null, undefined, Infinity, NaN]) {
        assert.throws(() => calculateListingPayment(listing, 'golds', quantity), /whole product quantity/, String(quantity));
    }
});

test('quantity multiplication must still fit existing USD and individual-game-unit payment limits', () => {
    const money = parseListing('Item: Product\nMoney: 9999999999.99');
    assert.equal(calculateListingPayment(money, 'money', 1).amount, 9999999999.99);
    assert.throws(() => calculateListingPayment(money, 'money', 2), /no more than/);
    const golds = parseListing('Item: Product\nGolds: 9999999999');
    assert.throws(() => calculateListingPayment(golds, 'golds', 2), /no more than|total game/);
    const stacks = parseListing('Item: Product\nRedblocks: 156249999 stacks');
    assert.equal(calculateListingPayment(stacks, 'redblocks', 1).amount, 156249999);
    assert.throws(() => calculateListingPayment(stacks, 'redblocks', 2), /total game payment/);
});

test('item names are bounded and cannot introduce mentions, controls, or extra formatting', () => {
    assert.equal(parseListing(`Item: ${'a'.repeat(200)}\nGolds: 33`).item.length, 200);
    for (const item of ['', 'a'.repeat(201), '<@123>', '@everyone', 'Product\u0000', '`Item`']) {
        assert.throws(() => parseListing(`Item: ${item}\nGolds: 33`), /listing-format/);
    }
    assert.throws(() => parseListing(`Item: Cape\n${' '.repeat(4001)}\nGolds: 33`), /4,000/);
});

test('listing fingerprints bind identity, exact text, and edit state without inspecting attachments', () => {
    const message = { id: '123', channelId: '456', author: { id: '789' }, content: 'Item: Cape\nGolds: 33', editedTimestamp: null };
    const fingerprint = listingFingerprint(message);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(listingFingerprint({ ...message, attachments: ['different-image.png'] }), fingerprint);
    for (const change of [
        { id: '124' }, { channelId: '457' }, { author: { id: '790' } },
        { content: 'Item: Cape\nGolds: 34' }, { editedTimestamp: 1234567890 },
    ]) {
        assert.notEqual(listingFingerprint({ ...message, ...change }), fingerprint);
    }
    assert.equal(listingFingerprint({ ...message, editedTimestamp: undefined }), fingerprint);
});
