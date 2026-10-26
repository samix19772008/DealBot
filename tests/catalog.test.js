const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCatalog } = require('../src/utils/catalog');
const { calculateListingPayment } = require('../src/utils/listings');
const posts = require('./fixtures/market-posts.json');

function matching(catalog, pattern) {
    const matches = catalog.products.filter(product => pattern.test(product.item));
    assert.equal(matches.length, 1, `Expected one ${pattern}; got ${matches.map(product => product.item).join(', ')}`);
    return matches[0];
}

function payment(product, key) {
    const options = product.options.filter(option => option.key === key);
    assert.equal(options.length, 1, `${product.item} must offer exactly one ${key} price`);
    return options[0];
}

test('the real decorated rank advertisement yields two isolated products and their four exact alternatives', () => {
    const catalog = parseCatalog(posts.ranks);
    assert.equal(catalog.version, 2);
    assert.equal(catalog.products.length, 2);
    assert.deepEqual(catalog.warnings, []);
    const special = matching(catalog, /Special Rank/i);
    const emerald = matching(catalog, /Emerald Rank/i);
    assert.equal(special.options.length, 4);
    assert.equal(emerald.options.length, 4);
    assert.equal(payment(special, 'money').amount, 22);
    assert.equal(payment(emerald, 'money').amount, 5.5);
    assert.equal(payment(special, 'golds').amount, 352);
    assert.equal(payment(special, 'golds').paymentUnit, 'each');
    assert.equal(payment(emerald, 'golds').amount, 84);
    assert.equal(payment(special, 'redblocks').amount, 135);
    assert.equal(payment(special, 'redblocks').paymentUnit, 'stacks');
    assert.equal(payment(emerald, 'redblocks').amount, 40);
    assert.equal(payment(special, 'sky1notchs').amount, 144);
    assert.equal(payment(emerald, 'sky1notchs').amount, 35);
    assert.equal(special.bundleQuantity, 1);
    assert.equal(special.stock, null);
    assert.equal(calculateListingPayment(special, 'golds', 2).amount, 704);
    assert.equal(calculateListingPayment(emerald, 'money', 2).amount, 11);
});

test('the real SkyPVP advertisement yields twenty separately priced products and bundle choices', () => {
    const catalog = parseCatalog(posts.skypvp);
    assert.equal(catalog.products.length, 20, JSON.stringify(catalog));
    assert.deepEqual(catalog.warnings, []);
    assert.equal(new Set(catalog.products.map(product => product.id)).size, 20);
    for (const [index, product] of catalog.products.entries()) {
        assert.equal(product.id, `p${index}`);
        assert.deepEqual(product.options.map(option => option.key), ['sky1notchs']);
        assert.equal(payment(product, 'sky1notchs').paymentUnit, 'each');
        assert.ok(product.item.length <= 200);
        assert.doesNotMatch(product.item, /<[:@#]|@everyone|1416701567649845289/);
    }
    assert.equal(payment(matching(catalog, /Full Set With Sword/i), 'sky1notchs').amount, 5);
    assert.equal(payment(matching(catalog, /Punch II$/i), 'sky1notchs').amount, 9);
    assert.equal(payment(matching(catalog, /Punch I$/i), 'sky1notchs').amount, 4);
    assert.equal(payment(matching(catalog, /90\s*Xp/i), 'sky1notchs').amount, 1);
    assert.equal(payment(matching(catalog, /180\s*Xp/i), 'sky1notchs').amount, 2);
    const applePacks = catalog.products.filter(product => /Golden.?Apple/i.test(product.item));
    assert.deepEqual(applePacks.map(product => product.bundleQuantity), [10, 24]);
    assert.deepEqual(applePacks.map(product => payment(product, 'sky1notchs').amount), [1, 2]);
    const rods = matching(catalog, /9\s*Rods/i);
    assert.equal(rods.bundleQuantity, 9);
    assert.equal(payment(rods, 'sky1notchs').amount, 1);
    assert.equal(calculateListingPayment(rods, 'sky1notchs', 2).amount, 2);
});

test('section stock before or after prices applies only to its product family, including sold-out books', () => {
    const catalog = parseCatalog(posts.skypvp);
    const family = (pattern, stock) => {
        const products = catalog.products.filter(product => pattern.test(product.item));
        assert.ok(products.length, `Missing ${pattern}`);
        assert.ok(products.every(product => product.stock === stock), JSON.stringify(products));
    };
    family(/Full Set With Sword/i, 55);
    family(/\bXp\b/i, 10095);
    family(/Golden.?Apple/i, 192);
    family(/Unbreaking III/i, 0);
    family(/Unbreaking II\b/i, 26);
    family(/Unbreaking I\b/i, 281);
    family(/Protection I\b/i, 325);
    family(/Sharpness IV/i, 13);
    family(/Potions/i, 217);
    family(/Stew/i, 221);
    family(/Rods/i, 295);
    const unavailable = catalog.products.filter(product => product.stock === 0);
    assert.equal(unavailable.length, 2);
    assert.ok(unavailable.every(product => /Unbreaking III/.test(product.item)));
});

test('simple fixed listings remain compatible and decorated sales prose does not supply extra prices', () => {
    const simple = parseCatalog('Item: Menace Cape\nMoney: $0.29\nGolds: 33');
    assert.equal(simple.products.length, 1);
    assert.equal(simple.products[0].item, 'Menace Cape');
    assert.equal(calculateListingPayment(simple.products[0], 'money', 3).amount, 0.87);
    const decorated = parseCatalog('# **Menace Cape**\nThe best cape for your collection!\n- Money <:Money:1416701478592319649>: 2$\nDM <@123456789012345678> or open <#987654321098765432>\n||@everyone||');
    assert.equal(decorated.products.length, 1);
    assert.deepEqual(decorated.products[0].options.map(option => option.key), ['money']);
    assert.equal(payment(decorated.products[0], 'money').amount, 2);
});

test('a price belongs to its product section and unavailable methods are never borrowed from another section', () => {
    const catalog = parseCatalog('# **First Cape**\nMoney: $2.00\n# Second Cape\nGolds: 33\nContact us for excellent support.');
    const first = matching(catalog, /First Cape/);
    const second = matching(catalog, /Second Cape/);
    assert.deepEqual(first.options.map(option => option.key), ['money']);
    assert.deepEqual(second.options.map(option => option.key), ['golds']);
    assert.throws(() => calculateListingPayment(second, 'money', 1), /offered/);
});

test('stack dot notation counts leftover items rather than decimal fractions and rejects leftovers of 64 or more', () => {
    const catalog = parseCatalog('# Cape\nGolds: 5.32 Stack\nRedblocks: 1.20 Stack\nSky1 Notchs: 2.16 Stack');
    const [cape] = catalog.products;
    assert.equal(payment(cape, 'golds').amount, 352);
    assert.equal(payment(cape, 'redblocks').amount, 84);
    assert.equal(payment(cape, 'sky1notchs').amount, 144);
    const invalid = '# Cape\nMoney: $2\nGolds: 5.64 Stack';
    const safe = parseCatalog(invalid);
    assert.equal(safe.products.length, 1);
    assert.deepEqual(safe.products[0].options.map(option => option.key), ['money']);
    assert.ok(safe.warnings.length > 0);
});

test('contradictory or ambiguous prices are withheld instead of choosing a cheaper number', () => {
    for (const price of ['Golds: 33 or 44', 'Golds: 33-44', 'Golds: -33', 'Golds: 33 + Money: $2', 'Golds: 33.5', 'Money: $2.001']) {
        let catalog;
        try { catalog = parseCatalog(`# Cape\n${price}`); }
        catch { continue; }
        assert.equal(catalog.products.length, 0, price);
        assert.ok(catalog.warnings.length > 0, price);
    }
    const duplicate = parseCatalog('# Cape\nMoney: $2\nGolds: 33\nGolds: 44');
    assert.deepEqual(duplicate.products[0].options.map(option => option.key), ['money']);
    assert.ok(duplicate.warnings.length > 0);
});

test('mentions, emoji IDs, stock amounts, enchantment levels and calls to action are not payment amounts', () => {
    const catalog = parseCatalog('# <:bow:1556810830673084556>\n- Punch II = 9 <:Sky1_Notch:1416701567649845289>\nStock: 123456\nFor 123 members <@123456789012345678> open <#1414954326056636453>\n||@everyone||');
    assert.equal(catalog.products.length, 1);
    assert.equal(payment(catalog.products[0], 'sky1notchs').amount, 9);
    assert.equal(catalog.products[0].stock, 123456);
    for (const content of ['', null, 'Open <#1414954326056636453> @everyone', '# Rare Cape\nStock: 55\n<:Money:1416701478592319649>', '# Cape\n90 XP = 1 <:unrelated:1416701567649845289>']) {
        assert.throws(() => parseCatalog(content), undefined, String(content));
    }
});

test('catalog parsing is stable across repeated calls and tolerates CRLF while keeping source products isolated', () => {
    const first = parseCatalog(posts.skypvp);
    assert.deepEqual(parseCatalog(posts.skypvp), first);
    assert.deepEqual(parseCatalog(posts.skypvp.replace(/\n/g, '\r\n')), first);
    assert.throws(() => parseCatalog('x'.repeat(10001)), /long|10,000|limit|large/i);
});

test('bold-only product headings start new sections rather than transferring the next product price', () => {
    const catalog = parseCatalog('**Cape One**\nMoney: $2\n**Cape Two**\nGolds: 33');
    assert.equal(catalog.products.length, 2);
    const first = matching(catalog, /Cape One/);
    const second = matching(catalog, /Cape Two/);
    assert.deepEqual(first.options.map(option => option.key), ['money']);
    assert.deepEqual(second.options.map(option => option.key), ['golds']);
});

test('decorated code-block listings and inline dollar prices keep the exact item relationships', () => {
    const fenced = parseCatalog('```text\n# Cape\nGolds: 33\n```\nDM <@123456789012345678> now!');
    assert.equal(fenced.products.length, 1);
    assert.equal(fenced.products[0].item, 'Cape');
    assert.equal(payment(fenced.products[0], 'golds').amount, 33);
    const inline = parseCatalog('# Shop\nCape = $2\nOther Cape = 3$');
    assert.equal(inline.products.length, 2);
    assert.equal(payment(matching(inline, /Shop.*· Cape$/), 'money').amount, 2);
    assert.equal(payment(matching(inline, /Other Cape$/), 'money').amount, 3);
});

test('one-digit and two-digit stack remainders preserve their written number of items', () => {
    const catalog = parseCatalog('# Cape\nGolds: 5.2 Stack\nRedblocks: 5.20 Stack\nSky1 Notchs: 0.63 Stack');
    const [cape] = catalog.products;
    assert.equal(payment(cape, 'golds').amount, 322);
    assert.equal(payment(cape, 'redblocks').amount, 340);
    assert.equal(payment(cape, 'sky1notchs').amount, 63);
    assert.ok(cape.options.every(option => option.paymentUnit === 'each'));
});

test('conflicting stock and crossed-out prices remain unavailable without erasing safe alternatives', () => {
    const catalog = parseCatalog('# Cape\nMoney: $2\nGolds: 33\nGolds: ~~44~~\nStock: 10\nStock: 20');
    assert.equal(catalog.products.length, 1);
    assert.deepEqual(catalog.products[0].options.map(option => option.key), ['money']);
    assert.equal(catalog.products[0].stock, 0);
    assert.ok(catalog.warnings.length >= 2);
});

test('many products receive stable unique IDs and the configured product limit fails explicitly', () => {
    const hundred = Array.from({ length: 100 }, (_, index) => `# Cape ${index}\nMoney: $2`).join('\n');
    const catalog = parseCatalog(hundred);
    assert.equal(catalog.products.length, 100);
    assert.equal(catalog.products[99].id, 'p99');
    assert.throws(() => parseCatalog(`${hundred}\n# Cape 100\nMoney: $2`), /100-product|product.*limit/i);
});

test('an empty replacement price removes the earlier method instead of leaving a stale purchasable amount', () => {
    const catalog = parseCatalog('# Cape\nMoney: $2\nGolds: 33\nGolds:');
    assert.deepEqual(catalog.products[0].options.map(option => option.key), ['money']);
    assert.ok(catalog.warnings.length > 0);
});

test('a contradictory multi-method price withholds every mentioned method while keeping an unrelated clear price', () => {
    const catalog = parseCatalog('# Cape\nMoney: $2\nGolds: 33\nRedblocks: 3\nGolds: 33 + Money: $5');
    assert.deepEqual(catalog.products[0].options.map(option => option.key), ['redblocks']);
    assert.equal(payment(catalog.products[0], 'redblocks').amount, 3);
    assert.ok(catalog.warnings.length > 0);
});

test('nested headings and a plain product title before a price cannot leak prices into the preceding product', () => {
    const catalog = parseCatalog('# Items\n## Bow\nMoney: $2\nSword\nGolds: 33\n## Cape\nRedblocks: 3');
    assert.equal(catalog.products.length, 3);
    assert.deepEqual(matching(catalog, /Bow/).options.map(option => option.key), ['money']);
    assert.deepEqual(matching(catalog, /Sword/).options.map(option => option.key), ['golds']);
    assert.deepEqual(matching(catalog, /Cape/).options.map(option => option.key), ['redblocks']);
});

test('struck-through product titles and sold-out notices preserve the offer as unavailable', () => {
    for (const post of [
        '# ~~Cape~~\nMoney: $2',
        '# Cape\nMoney: $2\nSold out',
        '# Cape\nMoney: $2\nOut of stock',
        '# Cape\nMoney: $2\nStock: 0',
    ]) {
        const catalog = parseCatalog(post);
        assert.equal(catalog.products.length, 1, post);
        assert.equal(catalog.products[0].stock, 0, post);
    }
});

test('a code block embedded after a live price does not add quoted historical offers to the catalog', () => {
    const catalog = parseCatalog('# Cape\nMoney: $2\n```text\n# Older Cape\nMoney: $5\n```\nOpen a ticket for more information.');
    assert.equal(catalog.products.length, 1);
    assert.equal(catalog.products[0].item, 'Cape');
    assert.equal(payment(catalog.products[0], 'money').amount, 2);
});

test('negative and fractional bundle quantities are never silently rewritten as positive whole packs', () => {
    for (const offer of ['-1 Book = 1 Sky1 Notchs', '1.5 Books = 1 Sky1 Notchs', '0 Books = 1 Sky1 Notchs']) {
        let catalog;
        try { catalog = parseCatalog(`# Enchanted Books\n${offer}\n# Cape\nMoney: $2`); }
        catch { continue; }
        assert.ok(catalog.products.every(product => !/Book/i.test(product.item)), offer);
        assert.equal(payment(matching(catalog, /Cape/), 'money').amount, 2);
    }
});

test('reused product names across separate sections are withheld instead of choosing between their prices', () => {
    for (const secondPrice of ['$22', '$2', 'not stated']) {
        assert.throws(() => parseCatalog(`# Cape\nMoney: $2\n# cApE\nMoney: ${secondPrice}`), /Repeated product names.*distinct name/i);
    }
});

test('an unrelated clear product remains available when duplicate-name offers are withheld', () => {
    const catalog = parseCatalog('# Cape\nMoney: $2\n# CAPE\nGolds: 33\n# Sword\nRedblocks: 3');
    assert.equal(catalog.products.length, 1);
    assert.equal(catalog.products[0].id, 'p0');
    assert.equal(catalog.products[0].item, 'Sword');
    assert.deepEqual(catalog.products[0].options.map(option => option.key), ['redblocks']);
    assert.ok(catalog.warnings.some(warning => /Repeated product names.*distinct name/i.test(warning)));
    const nested = parseCatalog('# Diamond Armour\n## Protection I\n1 Set = 2 Golds\n# Iron Armour\n## Protection I\n1 Set = 1 Golds');
    assert.equal(nested.products.length, 2);
    assert.deepEqual(nested.warnings, []);
    assert.match(nested.products[0].item, /Diamond Armour/);
    assert.match(nested.products[1].item, /Iron Armour/);
});

test('the real Redpvp advertisement keeps complete-set packs separate from component descriptions and stock', () => {
    const catalog = parseCatalog(posts.redpvp);
    assert.deepEqual(catalog.warnings, []);
    assert.equal(catalog.products.length, 2);
    const single = matching(catalog, /Redpvp Armour Sets · 1 Set$/);
    const ten = matching(catalog, /Redpvp Armour Sets · 10 Sets$/);
    assert.equal(single.bundleQuantity, 1);
    assert.equal(ten.bundleQuantity, 10);
    assert.equal(single.bundleUnit, 'Sets');
    assert.equal(ten.bundleUnit, 'Sets');
    assert.deepEqual(single.options.map(option => option.key), ['redblocks']);
    assert.deepEqual(ten.options.map(option => option.key), ['golds']);
    assert.equal(payment(single, 'redblocks').amount, 32);
    assert.equal(payment(single, 'redblocks').paymentUnit, 'each');
    assert.equal(payment(ten, 'golds').amount, 4);
    assert.equal(payment(ten, 'golds').paymentUnit, 'each');
    assert.ok(catalog.products.every(product => product.stock === null));
    assert.doesNotMatch(JSON.stringify(catalog), /86|56|76|45|43|Protection|Unbreaking|Sharpness|everyone|691841117012099164/);
});

test('set-pack quantities multiply only their own fixed price without exposing another pack payment method', () => {
    const catalog = parseCatalog(posts.redpvp);
    const single = matching(catalog, / · 1 Set$/);
    const ten = matching(catalog, / · 10 Sets$/);
    assert.equal(calculateListingPayment(single, 'redblocks', 2).amount, 64);
    assert.equal(calculateListingPayment(ten, 'golds', 2).amount, 8);
    assert.equal(ten.bundleQuantity * 2, 20);
    assert.throws(() => calculateListingPayment(single, 'golds', 1), /offered/);
    assert.throws(() => calculateListingPayment(ten, 'redblocks', 1), /offered/);
});

test('piece-stock changes never become an advertised complete-set stock, while explicit bundle stock does', () => {
    const changed = posts.redpvp.replace('Stock : 43', 'Stock : 1').replace('Stock : 86', 'Stock : 0');
    assert.ok(parseCatalog(changed).products.every(product => product.stock === null));
    const sharedStock = changed.replace('**# Prices :', '**# Prices :\n`Stock: 12`');
    const catalog = parseCatalog(sharedStock);
    assert.ok(catalog.products.every(product => product.stock === 12));
});

test('component headings written as words preserve the same explicit set context', () => {
    const post = posts.redpvp.replace('# <:Helm:1460422629465919539>', '# Helmet')
        .replace('# <:Chest:1460422475291562090>', '# Chestplate')
        .replace('# <:Leggings:1460422360988520610>', '# Leggings')
        .replace('# <:boot:1460422694922096875>', '# Boots')
        .replace('# <:diamond_sword:1135755525997482044>', '# Diamond Sword');
    const catalog = parseCatalog(post);
    assert.equal(catalog.products.length, 2);
    assert.ok(catalog.products.every(product => product.item.startsWith('Redpvp Armour Sets · ')));
    assert.ok(catalog.products.every(product => product.stock === null));
});

test('decorative Prices headings retain the actual product name instead of becoming a product', () => {
    for (const heading of ['# <:Prices:123456789012345678> <:arrow_down:234567890123456789>',
        '# <:Prices_arrow_down:123456789012345678>', '# Prices ⬇️', '# **Prices :**']) {
        const catalog = parseCatalog(`# Menace Cape\n${heading}\nMoney: $2`);
        assert.equal(catalog.products.length, 1);
        assert.equal(catalog.products[0].item, 'Menace Cape');
        assert.equal(payment(catalog.products[0], 'money').amount, 2);
    }
});

test('recognized redstone emoji names use the existing Redblocks payment without reading emoji identifiers as prices', () => {
    for (const name of ['redstone_dust', 'Redstone', 'Redstone_Block', 'redblocks']) {
        const catalog = parseCatalog(`# Cape\n1 Cape: 32 <:${name}:691841117012099164>`);
        assert.deepEqual(catalog.products[0].options.map(option => option.key), ['redblocks']);
        assert.equal(payment(catalog.products[0], 'redblocks').amount, 32);
        assert.equal(payment(catalog.products[0], 'redblocks').currency, 'Redblocks');
    }
    assert.throws(() => parseCatalog('# Cape\n1 Cape: 32 <:Redstone_Ore:691841117012099164>'), /No clear product prices/);
});
