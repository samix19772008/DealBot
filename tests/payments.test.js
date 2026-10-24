const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PAYMENT_METHODS, ITEMS_PER_STACK, MAX_GAME_UNITS,
    getPaymentMethod, resolvePayment, formatPayment,
} = require('../src/utils/payments');

test('payment methods are exactly the four market alternatives', () => {
    assert.deepEqual(PAYMENT_METHODS.map(({ key, label, currency }) => ({ key, label, currency })), [
        { key: 'money', label: 'Money', currency: 'USD' },
        { key: 'golds', label: 'Golds', currency: 'Golds' },
        { key: 'redblocks', label: 'Redblocks', currency: 'Redblocks' },
        { key: 'sky1notchs', label: 'Sky 1 Notchs', currency: 'Sky 1 Notchs' },
    ]);
    assert.equal(ITEMS_PER_STACK, 64);
    assert.equal(getPaymentMethod('  Sky 1 Notchs ').key, 'sky1notchs');
    assert.equal(getPaymentMethod('USD').key, 'money');
    assert.equal(getPaymentMethod('gold'), undefined);
});

test('listing alternatives keep their individual agreed amounts without exchange-rate conversion', () => {
    const alternatives = [
        { method: 'money', amount: 2, unit: 'each', display: 'Money · $2.00', currency: 'USD' },
        { method: 'golds', amount: 45, unit: 'each', display: '45 Golds', currency: 'Golds' },
        { method: 'redblocks', amount: 20, unit: 'stacks', display: '20 stacks of Redblocks (1,280 blocks)', currency: 'Redblocks' },
        { method: 'sky1notchs', amount: 20, unit: 'each', display: '20 Sky 1 Notchs', currency: 'Sky 1 Notchs' },
    ];
    for (const alternative of alternatives) {
        const payment = resolvePayment(alternative);
        assert.equal(payment.amount, alternative.amount);
        assert.equal(payment.currency, alternative.currency);
        assert.equal(payment.paymentUnit, alternative.unit);
        assert.equal(formatPayment(payment), alternative.display);
        assert.equal(formatPayment({ amount: payment.amount, currency: payment.currency, payment_unit: payment.paymentUnit }), alternative.display);
    }
});

test('Money accepts dollars and cents only, and never stacks', () => {
    assert.equal(resolvePayment({ method: 'money', amount: '0.01' }).amount, 0.01);
    assert.equal(resolvePayment({ method: 'money', amount: 9999999999.99 }).amount, 9999999999.99);
    assert.equal(formatPayment(resolvePayment({ method: 'Money', amount: '25.5' })), 'Money · $25.50');
    for (const amount of ['2.001', '2 USD', Infinity, NaN, -1, 0, '0', '1e3', '10000000000']) {
        assert.throws(() => resolvePayment({ method: 'money', amount }), undefined, String(amount));
    }
    assert.throws(() => resolvePayment({ method: 'money', amount: 2, unit: 'stacks' }), /not stacks/);
});

test('game payments accept only whole item or stack counts and calculate stacks of 64', () => {
    for (const method of ['golds', 'redblocks', 'sky1notchs']) {
        assert.equal(resolvePayment({ method, amount: '2', unit: 'Each' }).amount, 2);
        assert.equal(resolvePayment({ method, amount: 2, unit: 'stack' }).paymentUnit, 'stacks');
        for (const amount of ['0.5', 1.2, '1.001', 0, -1, Infinity]) {
            assert.throws(() => resolvePayment({ method, amount }), undefined, `${method}/${amount}`);
        }
    }
    assert.equal(formatPayment(resolvePayment({ method: 'redblocks', amount: 1, unit: 'stacks' })), '1 stack of Redblocks (64 blocks)');
    assert.equal(formatPayment(resolvePayment({ method: 'golds', amount: 2, unit: 'stacks' })), '2 stacks of Golds (128 items)');
});

test('stack totals cannot overflow the supported individual-item limit', () => {
    assert.equal(resolvePayment({ method: 'golds', amount: MAX_GAME_UNITS }).amount, MAX_GAME_UNITS);
    const maximumStacks = Math.floor(MAX_GAME_UNITS / ITEMS_PER_STACK);
    assert.equal(resolvePayment({ method: 'redblocks', amount: maximumStacks, unit: 'stacks' }).amount, maximumStacks);
    assert.throws(() => resolvePayment({ method: 'redblocks', amount: maximumStacks + 1, unit: 'stacks' }), /total game payment/);
    assert.throws(() => resolvePayment({ method: 'redblocks', amount: Number.MAX_SAFE_INTEGER, unit: 'stacks' }));
});

test('unsupported combinations, methods, and units are rejected', () => {
    for (const method of ['gold', 'BTC', 'Sky 2 Notchs', 'Golds + Redblocks', '', null]) {
        assert.throws(() => resolvePayment({ method, amount: 2 }), /Choose one payment method/);
    }
    assert.throws(() => resolvePayment({ method: 'redblocks', amount: 2, unit: 'boxes' }), /each.*stacks/);
});

test('legacy amounts and currencies remain literal instead of guessing their unit', () => {
    assert.equal(formatPayment({ amount: 20, currency: 'Redblocks', payment_unit: null }), '20 Redblocks');
    assert.equal(formatPayment({ amount: 20.5, currency: 'gold coins' }), '20.5 gold coins');
    assert.equal(formatPayment({ amount: 2, currency: 'USD', payment_unit: null }), '2 USD');
    assert.equal(formatPayment({ amount: 2, currency: 'Unknown currency', payment_unit: 'stacks' }), '2 Unknown currency');
});
