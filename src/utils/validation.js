const MAX_AMOUNT = 9999999999.99;

function parseAmount(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
        throw new Error('Enter a positive amount with no more than two decimal places, such as 25 or 25.50.');
    }
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
        throw new Error('The amount must be greater than zero and no more than 9,999,999,999.99.');
    }
    return amount;
}

function validateDealInput({ itemDescription, amount, currency = 'USD' }) {
    const item = String(itemDescription ?? '').trim();
    const unit = String(currency ?? '').trim();
    if (!item || item.length > 1000) {
        throw new Error('Describe the item or service using 1 to 1,000 characters.');
    }
    if (!unit || unit.length > 24 || /[\x00-\x1f\x7f<>@`]/.test(unit)) {
        throw new Error('Use a currency or payment unit of 1 to 24 characters, such as USD or gold.');
    }
    return { itemDescription: item, amount: parseAmount(amount), currency: unit };
}

function parsePrice(value) {
    const match = String(value ?? '').trim().match(/^(\d+(?:\.\d{1,2})?)\s+(.+)$/);
    if (!match) {
        throw new Error('Enter an amount followed by its currency, such as "50 gold" or "12.50 USD".');
    }
    const { amount, currency } = validateDealInput({ itemDescription: 'Price', amount: match[1], currency: match[2] });
    return { amount, currency };
}

function boundedText(value, maxLength = 1024) {
    const text = String(value ?? '').trim() || '—';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : text;
}

module.exports = { MAX_AMOUNT, parseAmount, parsePrice, validateDealInput, boundedText };
