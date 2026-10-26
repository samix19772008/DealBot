const { PAYMENT_METHODS, resolvePayment } = require('./payments');
const { parseListing } = require('./listings');

const MAX_CATALOG_PRODUCTS = 100;
const MAX_CATALOG_TEXT = 10000;
const METHOD_PATTERNS = {
    money: /\b(?:money|usd|dollars?|cash)\b|\$/gi,
    golds: /\bgolds?\b/gi,
    redblocks: /\bred[ _-]*blocks?\b/gi,
    sky1notchs: /\bsky[ _-]*1[ _-]*notch(?:s|es)?\b/gi,
};

function methodForEmoji(name) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['money', 'usd', 'dollar', 'dollars', 'cash'].includes(key)) return 'money';
    if (['gold', 'golds'].includes(key)) return 'golds';
    if (['redblock', 'redblocks', 'redstone', 'redstonedust', 'redstoneblock', 'redstoneblocks'].includes(key)) return 'redblocks';
    if (['sky1notch', 'sky1notchs', 'sky1notches'].includes(key)) return 'sky1notchs';
    return null;
}

function emojiHeading(names) {
    const keys = names.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (keys.some(key => /helm|chest|legging|boot|diamondsword/.test(key))) return 'Armour and Sword';
    if (keys.some(key => /^(?:str|strength|speed)$/.test(key))) return 'Potions';
    const labels = {
        bow: 'Bow', expbottle: 'Experience', experience: 'Experience',
        goldenapple: 'Golden Apple', enchantedbook: 'Enchanted Books',
        stew: 'Stew', rod: 'Rods', rods: 'Rods',
    };
    for (const key of keys) {
        const label = labels[key.replace(/^\d+/, '')];
        if (label) return label;
    }
    return names.map(name => name.replace(/^\d+/, '').replace(/_/g, ' ')).join(' ').trim();
}

function cleanLine(raw) {
    const names = [];
    const struck = /~~/.test(raw);
    let text = raw.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, (_, name) => {
        names.push(name);
        const key = methodForEmoji(name);
        return key ? ` ${PAYMENT_METHODS.find(method => method.key === key).label} ` : ' ';
    });
    text = text.replace(/<[@#][!&]?\d+>/g, ' ').replace(/@(?:everyone|here)\b/gi, ' ')
        .replace(/https?:\/\/\S+/gi, ' ').replace(/[*_`~|]/g, ' ').trim();
    const headingLevel = text.match(/^(#{1,6})(?:\s|$)/)?.[1].length || 1;
    const heading = /^#{1,6}(?:\s|$)/.test(text) ||
        /^\s*(?:\*\*[^*]+\*\*|__[^_]+__)\s*$/.test(raw);
    text = text.replace(/^#{1,6}\s*/, '').replace(/^(?:[-+•]|>)\s+/, '').replace(/\s+/g, ' ').trim();
    const emojiOnly = heading && !text;
    const equipmentHeading = heading && ((emojiOnly && emojiHeading(names) === 'Armour and Sword') ||
        /^(?:helm(?:et)?|chest(?:plate)?|leggings|boots?|(?:diamond\s+)?sword)$/i.test(text));
    if (emojiOnly) {
        const keys = names.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, ''));
        text = keys.some(key => /^prices?(?:arrowdown|downarrow)?$/.test(key)) && keys.every(key => /^(?:prices?(?:arrowdown|downarrow)?|arrowdown|downarrow|arrowdownsmall|smallredtriangledown)$/.test(key))
            ? 'Prices' : emojiHeading(names);
    }
    return { text, heading, headingLevel, struck, equipmentHeading };
}

function methodsIn(text) {
    return PAYMENT_METHODS.filter(method => {
        METHOD_PATTERNS[method.key].lastIndex = 0;
        return METHOD_PATTERNS[method.key].test(text);
    });
}

function isPriceHeading(text) {
    return /^prices?$/i.test(text.replace(/[\p{P}\p{S}\uFE0F]/gu, '').trim());
}

function methodLabel(text) {
    const candidates = methodsIn(text);
    if (candidates.length !== 1) return null;
    const pattern = METHOD_PATTERNS[candidates[0].key];
    pattern.lastIndex = 0;
    return text.replace(pattern, '').trim() === '' ? candidates[0] : null;
}

function parsePrice(text, methodHint, { stackNotation }) {
    const methods = methodsIn(text);
    const method = methodHint || (methods.length === 1 ? methods[0] : null);
    if (!method || methods.some(candidate => candidate.key !== method.key)) {
        throw new Error('Use exactly one supported payment method for each price.');
    }
    let amountText = text;
    const pattern = METHOD_PATTERNS[method.key];
    pattern.lastIndex = 0;
    amountText = amountText.replace(pattern, '').trim();
    if (method.key === 'money') {
        if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) throw new Error('Money prices need one USD amount with at most two decimals.');
        return { key: method.key, label: method.label, ...resolvePayment({ method: method.key, amount: amountText }) };
    }
    const match = amountText.match(/^(\d+)(?:\.(\d{1,2}))?(?:\s+(each|stack|stacks))?$/i);
    if (!match) throw new Error('Game prices need one whole amount, or stacks and leftover items.');
    const [, whole, remainder, rawUnit] = match;
    const unit = rawUnit?.toLowerCase() || 'each';
    let amount = whole;
    let paymentUnit = unit === 'stack' ? 'stacks' : unit;
    if (remainder != null) {
        if (paymentUnit !== 'stacks' || stackNotation !== 'items' || Number(remainder) >= 64) {
            throw new Error('Stack dot notation uses leftover items from 0 to 63, for example 5.32 Stack means 5 stacks and 32 items.');
        }
        amount = Number(whole) * 64 + Number(remainder);
        if (!Number.isSafeInteger(amount)) throw new Error('The game price is too large.');
        paymentUnit = 'each';
    }
    return { key: method.key, label: method.label,
        ...resolvePayment({ method: method.key, amount, unit: paymentUnit }) };
}

function safeTitle(value) {
    const title = String(value ?? '').trim();
    if (!title || title.length > 200 || /[\x00-\x1f\x7f<>@`]/.test(title)) {
        throw new Error('A detected product needs a clear name of 1 to 200 characters without mentions.');
    }
    return title;
}

function bundleFor(offer, heading) {
    if (/^[+-]?\d/.test(offer) && !/^[1-9]\d*(?:\s|[A-Za-z]|$)/.test(offer)) {
        throw new Error('A product bundle must contain a positive whole number of items.');
    }
    const explicit = offer.match(/^(\d+)\s*(books?|potions?|stews?|rods?|sets?|xp|experience|golden\s*apples?)\b/i);
    if (explicit) {
        const count = Number(explicit[1]);
        if (!Number.isSafeInteger(count) || count < 1 || count > 9999999999) throw new Error('The bundle size is invalid.');
        const unit = explicit[2].toLowerCase();
        const bundleUnit = /^(?:xp|experience)$/.test(unit) ? 'XP' :
            /^book/.test(unit) ? 'Books' : /^potion/.test(unit) ? 'Potions' :
                /^stew/.test(unit) ? 'Stews' : /^rod/.test(unit) ? 'Rods' : /^set/.test(unit) ? 'Sets' : 'Golden Apples';
        return { bundleQuantity: count, bundleUnit };
    }
    if (/^\d+$/.test(offer) && /golden\s*apple/i.test(heading)) {
        const count = Number(offer);
        if (!Number.isSafeInteger(count) || count < 1 || count > 9999999999) throw new Error('The bundle size is invalid.');
        return { bundleQuantity: count, bundleUnit: 'Golden Apples' };
    }
    const generic = offer.match(/^(\d+)\s+([A-Za-z][A-Za-z ]{0,49})$/);
    if (generic) {
        const count = Number(generic[1]);
        if (!Number.isSafeInteger(count) || count < 1 || count > 9999999999) throw new Error('The bundle size is invalid.');
        return { bundleQuantity: count, bundleUnit: generic[2] };
    }
    if (/^[+-]?\d/.test(offer)) throw new Error('A numeric bundle needs a clear item name and whole quantity.');
    return { bundleQuantity: 1, bundleUnit: null };
}

/** Validate saved snapshots without trying to turn their titles back into post syntax. */
function normalizeCatalog(catalog) {
    if (!catalog || catalog.version !== 2 || !Array.isArray(catalog.products) ||
        catalog.products.length < 1 || catalog.products.length > MAX_CATALOG_PRODUCTS ||
        !Array.isArray(catalog.warnings)) throw new Error('The saved product catalog is invalid. Reopen the listing.');
    const ids = new Set();
    const products = catalog.products.map(product => {
        if (!product || typeof product.id !== 'string' || !/^p\d{1,3}$/.test(product.id) || ids.has(product.id) ||
            !Array.isArray(product.options) || product.options.length < 1 || product.options.length > 4) {
            throw new Error('The saved product options are invalid. Reopen the listing.');
        }
        ids.add(product.id);
        const seen = new Set();
        const options = product.options.map(option => {
            const method = PAYMENT_METHODS.find(candidate => candidate.key === option?.key);
            if (!method || seen.has(method.key)) throw new Error('The saved payment methods are invalid.');
            seen.add(method.key);
            const payment = resolvePayment({ method: method.key, amount: option.amount, unit: option.paymentUnit });
            if (payment.currency !== option.currency) throw new Error('The saved currency does not match its payment method.');
            return { key: method.key, label: method.label, ...payment };
        });
        const quantity = product.bundleQuantity ?? 1;
        const unit = product.bundleUnit ?? null;
        const stock = product.stock ?? null;
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999999999 ||
            (unit != null && (typeof unit !== 'string' || !unit.trim() || unit.length > 50 || /[\x00-\x1f\x7f<>@`]/.test(unit))) ||
            (stock != null && (!Number.isSafeInteger(stock) || stock < 0 || stock > 9999999999))) {
            throw new Error('The saved bundle size or advertised stock is invalid.');
        }
        return { id: product.id, item: safeTitle(product.item), options,
            bundleQuantity: quantity, bundleUnit: unit, stock };
    });
    const warnings = catalog.warnings.map(warning => {
        if (typeof warning !== 'string' || !warning || warning.length > 500 || /[\x00-\x1f\x7f<>@`]/.test(warning)) {
            throw new Error('The saved catalog warnings are invalid.');
        }
        return warning;
    });
    if (warnings.length > 100) throw new Error('The saved catalog has too many warnings.');
    return { version: 2, products, warnings };
}

/** Parse clear price relationships while leaving marketing text and Discord mentions alone. */
function parseCatalog(content, { stackNotation = 'items' } = {}) {
    if (typeof content !== 'string' || !content.trim()) throw new Error('This post needs text prices; image-only prices cannot be read.');
    if (content.length > MAX_CATALOG_TEXT) throw new Error('The post exceeds the 10,000-character parsing limit.');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error('The post contains unsupported control characters.');
    // Keep clean version 1.4 posts and their literal stack counts compatible.
    try {
        const listing = parseListing(content);
        return { version: 2, products: [{ id: 'p0', ...listing, bundleQuantity: 1, bundleUnit: null, stock: null }], warnings: [] };
    } catch { /* Decorated and multi-product posts use section parsing below. */ }

    const products = [];
    const warnings = [];
    let section = { title: '', stock: null, products: [], unavailable: false };
    // A seller can describe each armour component before listing prices for the
    // complete set. Component headings and their stocks are not bundle terms.
    let setDescription = null;
    const headingPath = [];
    const warn = message => { if (warnings.length < 100 && !warnings.includes(message)) warnings.push(message); };
    const finishSection = () => { for (const product of section.products) product.stock = section.unavailable ? 0 : section.stock; };
    const newSection = (title, { level = 1, struck = false, plain = false } = {}) => {
        finishSection();
        headingPath.length = plain ? 0 : level - 1;
        if (!plain) headingPath[level - 1] = title;
        section = { title: safeTitle(plain ? title : headingPath.filter(Boolean).join(' · ')), stock: null, products: [], unavailable: struck };
        if (struck) warn('A crossed-out product section was treated as unavailable.');
    };
    const getProduct = (offer = null) => {
        const item = safeTitle(offer ? (section.title ? `${section.title} · ${offer}` : offer) : section.title);
        let product = section.products.find(candidate => candidate.item === item);
        if (!product) {
            if (products.length >= MAX_CATALOG_PRODUCTS) throw new Error(`The post exceeds the ${MAX_CATALOG_PRODUCTS}-product parsing limit.`);
            product = { item, options: [], ...bundleFor(offer || '', section.title), stock: null, invalidMethods: new Set() };
            section.products.push(product);
            products.push(product);
        }
        return product;
    };
    const addPrice = (product, price, hint, lineNumber, struck) => {
        let method = hint;
        if (!method) {
            const candidates = methodsIn(price);
            if (candidates.length === 1) [method] = candidates;
        }
        const implicated = new Set([...(method ? [method.key] : []), ...methodsIn(price).map(candidate => candidate.key)]);
        const invalidate = () => {
            product.options = product.options.filter(option => !implicated.has(option.key));
            for (const key of implicated) product.invalidMethods.add(key);
        };
        if (!method) { invalidate(); warn(`Line ${lineNumber}: an ambiguous payment method was omitted.`); return; }
        try {
            if (struck) throw new Error('Crossed-out or replacement prices need seller clarification.');
            const option = parsePrice(price, method, { stackNotation });
            if (product.invalidMethods.has(method.key) || product.options.some(existing => existing.key === method.key)) {
                throw new Error('More than one price for the same product and method needs seller clarification.');
            }
            product.options.push(option);
        } catch (error) {
            invalidate();
            warn(`Line ${lineNumber}: ${error.message}`);
        }
    };

    const lines = content.split(/\r?\n/);
    let codeBlock = null;
    for (const [index, raw] of lines.entries()) {
        if (/^\s*```[a-z]*\s*$/i.test(raw)) {
            if (codeBlock != null) codeBlock = null;
            else {
                codeBlock = products.some(product => product.options.length > 0) ? 'skip' : 'parse';
                if (codeBlock === 'skip') warn('An embedded code example after active prices was omitted; review its meaning with the seller.');
            }
            continue;
        }
        if (codeBlock === 'skip') continue;
        const { text, heading, headingLevel, struck, equipmentHeading } = cleanLine(raw);
        if (!text || /^```/.test(text) || /^(?:text|plaintext|deal)$/i.test(text)) continue;
        if (/^(?:currently\s+)?(?:sold\s*out|out\s*of\s*stock|unavailable)(?:\b|[.!])/i.test(text) && !/[=:]/.test(text)) {
            section.unavailable = true;
            continue;
        }
        const stockMatch = text.match(/^stock\s*:?\s*(\d+)\s*$/i);
        if (stockMatch) {
            const value = Number(stockMatch[1]);
            if (!Number.isSafeInteger(value) || value > 9999999999) {
                section.stock = 0;
                warn(`Line ${index + 1}: unclear advertised stock was treated as unavailable.`);
            } else if (section.stock != null && section.stock !== value) {
                section.stock = 0;
                warn(`Line ${index + 1}: conflicting advertised stock was treated as unavailable.`);
            } else section.stock = value;
            continue;
        }
        if (/^stock\s*:/i.test(text)) {
            section.stock = 0;
            warn(`Line ${index + 1}: unclear advertised stock was treated as unavailable.`);
            continue;
        }
        if (isPriceHeading(text)) {
            if (setDescription?.components > 1) {
                const following = lines.slice(index + 1).map(cleanLine);
                const boundary = following.findIndex(line => line.heading && !isPriceHeading(line.text));
                const block = boundary < 0 ? following : following.slice(0, boundary);
                if (block.some(line => /^\d+\s+sets?\s*(?:=|:)\s*/i.test(line.text))) {
                    newSection(setDescription.title, { plain: true, struck: setDescription.struck });
                }
            }
            continue;
        }
        const itemLine = text.match(/^item\s*:\s*(.+)$/i);
        if (itemLine) { newSection(itemLine[1]); continue; }
        const labeled = text.match(/^(.+?)\s*:\s*(.*)$/);
        if (labeled) {
            const method = methodLabel(labeled[1]);
            if (method) {
                if (!section.title) { warn(`Line ${index + 1}: a price without a clear product name was omitted.`); continue; }
                addPrice(getProduct(), labeled[2], method, index + 1, struck);
                continue;
            }
        }
        const inline = text.match(/^(.+?)\s*(?:=|:)\s*(.+)$/);
        if (inline && methodsIn(inline[2]).length) {
            addPrice(getProduct(inline[1].trim()), inline[2], null, index + 1, struck);
            continue;
        }
        if (heading) {
            const title = text.replace(/\s*:\s*$/, '');
            if (equipmentHeading) {
                if (setDescription) setDescription.components++;
            } else {
                setDescription = /\bsets?\b/i.test(title)
                    ? { title: title.replace(/^selling\s+/i, ''), components: 0, struck } : null;
            }
            newSection(title, { level: headingLevel, struck });
            continue;
        }
        const next = lines.slice(index + 1).find(line => line.trim());
        const nextLabel = next && cleanLine(next).text.match(/^(.+?)\s*:\s*(.*)$/);
        if (section.title && nextLabel && methodLabel(nextLabel[1]) &&
            /^[A-Za-z][A-Za-z0-9 '()-]{0,99}$/.test(text) &&
            !/^(?:the|they|these|our|this|open|contact|dm|buy|stock|limited|special offer)\b/i.test(text)) {
            newSection(text, { struck, plain: true });
            continue;
        }
        // A simple title before explicit prices is unambiguous even without '#'.
        if (!section.title && text.length <= 200 && !/[=:]/.test(text) && !/^(?:open|contact|dm|selling|buy|stock)\b/i.test(text)) {
            newSection(text, { plain: true });
        }
    }
    finishSection();
    const names = new Map();
    for (const product of products) {
        const key = product.item.toLowerCase();
        names.set(key, (names.get(key) || 0) + 1);
    }
    const repeatedNames = new Set([...names].filter(([, count]) => count > 1).map(([key]) => key));
    if (repeatedNames.size) {
        warn('Repeated product names in separate sections were omitted. Give every product or variant a distinct name.');
    }
    const available = products.filter(product => product.options.length > 0 && !repeatedNames.has(product.item.toLowerCase()))
        .map(({ invalidMethods, ...product }, index) => ({ id: `p${index}`, ...product }));
    if (!available.length && repeatedNames.size) {
        throw new Error('Repeated product names are ambiguous. Give every product or variant a distinct name, then reopen the listing.');
    }
    if (!available.length) throw new Error(warnings[0] || 'No clear product prices were found. The seller can review this post with Preview Listing.');
    return normalizeCatalog({ version: 2, products: available, warnings });
}

module.exports = { parseCatalog, normalizeCatalog, MAX_CATALOG_PRODUCTS, MAX_CATALOG_TEXT };
