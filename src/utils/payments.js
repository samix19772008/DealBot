const { MAX_AMOUNT, parseAmount } = require('./validation');

const ITEMS_PER_STACK = 64;
const MAX_GAME_UNITS = Math.floor(MAX_AMOUNT);
const PAYMENT_METHODS = Object.freeze([
    Object.freeze({ key: 'money', label: 'Money', currency: 'USD', description: 'US dollars, with up to two decimal places' }),
    Object.freeze({ key: 'golds', label: 'Golds', currency: 'Golds', description: 'Whole Golds, individually or in stacks of 64' }),
    Object.freeze({ key: 'redblocks', label: 'Redblocks', currency: 'Redblocks', description: 'Whole Redblocks, individually or in stacks of 64' }),
    Object.freeze({ key: 'sky1notchs', label: 'Sky 1 Notchs', currency: 'Sky 1 Notchs', description: 'Whole Sky 1 Notchs, individually or in stacks of 64' }),
]);

/** Resolve one of the four supported methods; these are alternatives, not exchange rates. */
function getPaymentMethod(value) {
    const key = String(value ?? '').trim().toLowerCase();
    return PAYMENT_METHODS.find(method => [method.key, method.label, method.currency]
        .some(alias => alias.toLowerCase() === key));
}

function resolvePayment({ method, amount, unit = 'each' } = {}) {
    const payment = getPaymentMethod(method);
    if (!payment) throw new Error('Choose one payment method: Money, Golds, Redblocks, or Sky 1 Notchs.');
    let paymentUnit = String(unit ?? 'each').trim().toLowerCase() || 'each';
    if (paymentUnit === 'stack') paymentUnit = 'stacks';
    if (!['each', 'stacks'].includes(paymentUnit)) {
        throw new Error('Use each for individual units or stacks for groups of 64 items.');
    }
    const value = parseAmount(amount);
    if (payment.key === 'money') {
        if (paymentUnit !== 'each') throw new Error('Money is entered in US dollars, not stacks.');
    } else {
        if (!Number.isSafeInteger(value)) throw new Error('Game payments must use a whole number of items or stacks.');
        const total = value * (paymentUnit === 'stacks' ? ITEMS_PER_STACK : 1);
        if (!Number.isSafeInteger(total) || total > MAX_GAME_UNITS) {
            throw new Error('The total game payment must not exceed 9,999,999,999 individual items.');
        }
    }
    return { amount: value, currency: payment.currency, paymentUnit };
}

/** Display explicit units without guessing what a legacy record meant. */
function formatPayment({ amount, currency, payment_unit: storedUnit, paymentUnit } = {}) {
    const unit = storedUnit ?? paymentUnit;
    const rawAmount = Number.isFinite(Number(amount))
        ? Number(amount).toLocaleString('en-US', { maximumFractionDigits: 20 })
        : String(amount ?? '—');
    const legacy = `${rawAmount} ${String(currency ?? '')}`.trim();
    if (unit == null) return legacy;
    let payment;
    try { payment = resolvePayment({ method: currency, amount, unit }); }
    catch { return legacy; }
    const method = getPaymentMethod(payment.currency);
    if (method.key === 'money') {
        return `Money · ${payment.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
    }
    const count = payment.amount.toLocaleString('en-US');
    if (payment.paymentUnit === 'stacks') {
        const total = (payment.amount * ITEMS_PER_STACK).toLocaleString('en-US');
        const individualLabel = payment.currency === 'Redblocks' ? 'blocks' : 'items';
        return `${count} ${payment.amount === 1 ? 'stack' : 'stacks'} of ${payment.currency} (${total} ${individualLabel})`;
    }
    return `${count} ${payment.currency}`;
}

module.exports = { PAYMENT_METHODS, ITEMS_PER_STACK, MAX_GAME_UNITS, getPaymentMethod, resolvePayment, formatPayment };
