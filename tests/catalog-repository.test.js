process.env.DATABASE_PATH = ':memory:';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { db } = require('../src/database/init');
const repository = require('../src/database/listingRepository');
const { createEscrow } = require('../src/database/escrowRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
const { parseListing } = require('../src/utils/listings');
const project = path.join(__dirname, '..');
let sequence = 0;

after(() => db.close());

const sky = amount => ({ key: 'sky1notchs', label: 'Sky 1 Notchs', amount, currency: 'Sky 1 Notchs', paymentUnit: 'each' });
const money = amount => ({ key: 'money', label: 'Money', amount, currency: 'USD', paymentUnit: 'each' });
const gold = amount => ({ key: 'golds', label: 'Golds', amount, currency: 'Golds', paymentUnit: 'each' });
function catalog() {
    return { version: 2, warnings: [], products: [
        { id: 'p0', item: 'Unbreaking II - 3 Books', options: [sky(2)], bundleQuantity: 3, bundleUnit: 'Books', stock: 26 },
        { id: 'p1', item: 'Special Rank', options: [money(22), gold(352)], bundleQuantity: 1, bundleUnit: null, stock: null },
        { id: 'p2', item: 'Unbreaking III - 1 Book', options: [sky(1)], bundleQuantity: 1, bundleUnit: 'Book', stock: 0 },
        { id: 'p3', item: 'Money-only add-on', options: [money(0.29)], bundleQuantity: 1, bundleUnit: null, stock: 1 },
        { id: 'p4', item: 'Protection I - 4 Books', options: [sky(2)], bundleQuantity: 4, bundleUnit: 'Books', stock: 325 },
    ] };
}

function fixture(snapshot = catalog(), options = {}) {
    const suffix = ++sequence;
    const buyer = getOrCreateUser({ id: `catalog-buyer-${suffix}`, tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: `catalog-seller-${suffix}`, tag: 'Seller', createdAt: new Date('2020-01-01') });
    const params = { guildId: `catalog-guild-${suffix}`, channelId: `catalog-channel-${suffix}`, messageId: `catalog-message-${suffix}`,
        buyerDiscordId: buyer.discord_id, sellerDiscordId: seller.discord_id,
        catalog: snapshot, sourceFingerprint: 'b'.repeat(64), now: 100000, ...options };
    const session = repository.createListingRequest(params);
    const request = { guildId: params.guildId, buyerDiscordId: buyer.discord_id, methodKey: 'sky1notchs',
        productId: 'p0', quantity: 2, now: 100000 };
    return { params, session, request, buyer, seller };
}

function createParameters(f, overrides = {}) {
    const request = { ...f.request, ...overrides };
    const quote = repository.getListingQuote(f.session.token, request);
    return { guildId: f.params.guildId, buyerId: f.buyer.id, sellerId: f.seller.id,
        itemDescription: quote.itemDescription, ...quote.payment,
        listingRequest: { token: f.session.token, productId: request.productId, methodKey: request.methodKey,
            quantity: request.quantity, now: request.now } };
}

function child(script, filename) {
    return spawnSync(process.execPath, ['-e', script], { cwd: project,
        env: { ...process.env, DATABASE_PATH: filename }, encoding: 'utf8' });
}

test('catalog snapshots retain distinct products and require an explicit selection for multiple products', () => {
    const f = fixture();
    const stored = repository.getListingRequest(f.session.token, f.request);
    assert.equal(stored.catalog.version, 2);
    assert.equal(stored.catalog.products.length, 5);
    assert.equal(stored.listing, undefined);
    assert.equal(repository.getSelectedProduct(stored.catalog, 'p1').item, 'Special Rank');
    for (const productId of [undefined, null, '', 'p999', 'p1_money']) {
        assert.throws(() => repository.getListingQuote(f.session.token, { ...f.request, productId }), { code: 'LISTING_REQUEST_INVALID' });
    }
    f.params.catalog.products[0].options[0].amount = 1;
    stored.catalog.products[0].bundleQuantity = 1;
    const reloaded = repository.getListingRequest(f.session.token, f.request);
    assert.equal(reloaded.catalog.products[0].options[0].amount, 2);
    assert.equal(reloaded.catalog.products[0].bundleQuantity, 3);
});

test('each product exposes only its own prices even when other products advertise more methods', () => {
    const f = fixture();
    assert.throws(() => repository.getListingQuote(f.session.token, { ...f.request, methodKey: 'money' }), /offered/);
    assert.throws(() => repository.getListingQuote(f.session.token, { ...f.request, productId: 'p1', methodKey: 'sky1notchs' }), /offered/);
    const rank = repository.getListingQuote(f.session.token, { ...f.request, productId: 'p1', methodKey: 'golds' });
    assert.equal(rank.product.id, 'p1');
    assert.equal(rank.listing.item, 'Special Rank');
    assert.equal(rank.payment.amount, 704);
    assert.equal(rank.payment.currency, 'Golds');
    assert.equal(rank.payment.paymentUnit, 'each');
});

test('quantity means packs and preserves pack size separately from exact game and Money totals', () => {
    const f = fixture();
    const books = repository.getListingQuote(f.session.token, f.request);
    assert.equal(books.payment.amount, 4);
    assert.equal(books.payment.quantity, 2);
    assert.equal(books.payment.unitAmount, 2);
    assert.match(books.itemDescription, /Quantity: 2/);
    assert.match(books.itemDescription, /Pack size: 3 Books/);
    assert.match(books.itemDescription, /Total items: 6 Books/);
    assert.match(books.itemDescription, /Unit price: 2 Sky 1 Notchs/);
    const cents = repository.getListingQuote(f.session.token, { ...f.request, productId: 'p3', methodKey: 'money', quantity: 3 });
    assert.equal(cents.payment.amount, 0.87);
    assert.doesNotMatch(cents.itemDescription, /Pack size:/);
});

test('advertised zero stock blocks ordering while positive stock is informational rather than a reservation', () => {
    const f = fixture();
    assert.throws(() => repository.getListingQuote(f.session.token, { ...f.request, productId: 'p2' }), /stock|unavailable/i);
    const available = repository.getListingQuote(f.session.token, { ...f.request, quantity: 999 });
    assert.equal(available.product.stock, 26);
    assert.equal(available.payment.amount, 1998);
    assert.equal(available.payment.quantity, 999);
    assert.throws(() => repository.getListingQuote(f.session.token, { ...f.request, quantity: 1000 }), /quantity/);
});

test('atomic escrow creation stores selected product, bundle and stock without mixing catalog alternatives', () => {
    const f = fixture();
    const parameters = createParameters(f);
    const escrow = createEscrow(parameters);
    const terms = repository.getEscrowListingTerms(escrow.id);
    assert.equal(terms.product_key, 'p0');
    assert.equal(terms.item, 'Unbreaking II - 3 Books');
    assert.equal(terms.bundle_quantity, 3);
    assert.equal(terms.bundle_unit, 'Books');
    assert.equal(terms.advertised_stock, 26);
    assert.equal(terms.quantity, 2);
    assert.equal(terms.total_amount, 4);
    assert.equal(JSON.parse(terms.listing_json).products.length, 5);
    assert.throws(() => createEscrow(parameters), /already been submitted/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions WHERE guild_id = ?').get(f.params.guildId).count, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('original source text is saved exactly and remains independent of later caller edits', () => {
    const sourceContent = '# **Books for sale** <:book:123456789012345678>\nArmour Unbreaking III and Protection II\n3 Books = 2 Sky1 Notchs\nContact <@123456789012345678> or <#987654321098765432>\n||@everyone||';
    const f = fixture(undefined, { sourceContent });
    assert.equal(f.session.source_content, sourceContent);
    f.params.sourceContent = '# Edited advertisement\n3 Books = 99 Sky1 Notchs';
    f.session.source_content = 'Changed returned object';
    const original = repository.getListingRequest(f.session.token, f.request);
    assert.equal(original.source_content, sourceContent);
    const escrow = createEscrow(createParameters(f));
    assert.equal(repository.getEscrowListingTerms(escrow.id).source_content, sourceContent);
    assert.equal(repository.getEscrowListingTerms(escrow.id).total_amount, 4);
    for (const invalidSource of [42, {}, [], 'x'.repeat(10001)]) {
        assert.throws(() => repository.createListingRequest({ ...f.params, sourceContent: invalidSource }),
            { code: 'LISTING_REQUEST_INVALID' });
    }
});

test('switching the product ID in a quoted request cannot purchase a different pack at the same total', () => {
    const f = fixture();
    const parameters = createParameters(f);
    parameters.listingRequest.productId = 'p4';
    assert.throws(() => createEscrow(parameters), { code: 'LISTING_REQUEST_INVALID' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions WHERE guild_id = ?').get(f.params.guildId).count, 0);
    assert.equal(repository.getListingRequest(f.session.token, f.request).consumed_escrow_id, null);
    const correct = createEscrow(createParameters(f, { productId: 'p4' }));
    assert.equal(repository.getEscrowListingTerms(correct.id).bundle_quantity, 4);
});

test('a legacy single-product request keeps its stored JSON and exact original quote semantics', () => {
    const f = fixture();
    const listing = parseListing('Item: Legacy Cape\nGolds: 33');
    const session = repository.createListingRequest({ ...f.params, catalog: undefined, listing });
    const rawBefore = db.prepare('SELECT listing_json FROM listing_request_sessions WHERE token = ?').get(session.token).listing_json;
    assert.deepEqual(JSON.parse(rawBefore), listing);
    const request = { ...f.request, productId: undefined, methodKey: 'golds' };
    const reloaded = repository.getListingRequest(session.token, request);
    assert.deepEqual(reloaded.listing, listing);
    assert.equal(reloaded.catalog.products.length, 1);
    assert.equal(reloaded.catalog.products[0].id, 'p0');
    const quote = repository.getListingQuote(session.token, request);
    assert.equal(quote.payment.amount, 66);
    assert.match(quote.itemDescription, /^Legacy Cape\nQuantity: 2\nUnit price: 33 Golds\nSource:/);
    assert.doesNotMatch(quote.itemDescription, /Pack size:|Total items:/);
    assert.equal(db.prepare('SELECT listing_json FROM listing_request_sessions WHERE token = ?').get(session.token).listing_json, rawBefore);
});

test('new single-product catalogs may omit product selection without losing bundle metadata', () => {
    const single = catalog();
    single.products = [single.products[0]];
    const f = fixture(single);
    const quote = repository.getListingQuote(f.session.token, { ...f.request, productId: undefined });
    assert.equal(quote.product.id, 'p0');
    assert.equal(quote.product.bundleQuantity, 3);
    assert.equal(quote.payment.amount, 4);
    assert.match(quote.itemDescription, /Total items: 6 Books/);
});

test('catalog snapshots and selected terms survive a fresh process with unchanged canonical prices', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-catalog-restart-'));
    const filename = path.join(directory, 'catalog.sqlite');
    const sourceContent = '# Books\n3 Books = 2 Sky1 Notchs\nProtection II included\n||@everyone||';
    try {
        const prepared = child(`
            const r=require('./src/database/listingRepository');
            const u=require('./src/database/userRepository');
            const buyer=u.getOrCreateUser({id:'buyer',tag:'Buyer',createdAt:new Date('2020-01-01')});
            const seller=u.getOrCreateUser({id:'seller',tag:'Seller',createdAt:new Date('2020-01-01')});
            const catalog=${JSON.stringify(catalog())};
            const session=r.createListingRequest({guildId:'guild',channelId:'channel',messageId:'message',
                buyerDiscordId:'buyer',sellerDiscordId:'seller',catalog,sourceFingerprint:'b'.repeat(64),sourceContent:${JSON.stringify(sourceContent)},now:100000});
            console.log(JSON.stringify({token:session.token,buyerId:buyer.id,sellerId:seller.id}));
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(prepared.status, 0, prepared.stderr);
        const payload = JSON.parse(prepared.stdout);
        const restarted = child(`
            const assert=require('node:assert/strict');
            const r=require('./src/database/listingRepository');
            const payload=${JSON.stringify(payload)};
            const request={guildId:'guild',buyerDiscordId:'buyer',productId:'p0',methodKey:'sky1notchs',quantity:2,now:100000};
            const quote=r.getListingQuote(payload.token,request);
            assert.equal(quote.product.bundleQuantity,3);assert.equal(quote.payment.amount,4);
            assert.equal(quote.session.source_content,${JSON.stringify(sourceContent)});
            const escrow=require('./src/database/escrowRepository').createEscrow({guildId:'guild',buyerId:payload.buyerId,sellerId:payload.sellerId,
                itemDescription:quote.itemDescription,...quote.payment,listingRequest:{token:payload.token,...request}});
            const terms=r.getEscrowListingTerms(escrow.id);
            assert.equal(terms.product_key,'p0');assert.equal(terms.bundle_quantity,3);assert.equal(terms.total_amount,4);
            assert.equal(terms.source_content,${JSON.stringify(sourceContent)});
            assert.deepEqual(require('./src/database/init').db.pragma('foreign_key_check'),[]);
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(restarted.status, 0, restarted.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('upgrading a version 1.4 database adds catalog metadata without changing saved legacy terms', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-catalog-migration-'));
    const filename = path.join(directory, 'legacy.sqlite');
    const legacy = new Database(filename);
    try {
        const oldSchema = fs.readFileSync(path.join(project, 'src/database/schema.sql'), 'utf8')
            .replace(/^.*\b(?:product_key|bundle_quantity|bundle_unit|advertised_stock|source_content)\b.*\r?\n/gm, '');
        legacy.exec(oldSchema);
        legacy.exec(`INSERT INTO users (id,discord_id,username,account_created_at) VALUES
            (1,'buyer','Buyer','2020-01-01'),(2,'seller','Seller','2020-01-01');
            INSERT INTO escrow_transactions
                (id,transaction_uuid,guild_id,buyer_id,seller_id,item_description,amount,currency,payment_unit)
                VALUES(1,'ESC-LEGACY-CATALOG','guild',1,2,'Original description',66,'Golds','each');`);
        const listingJson = JSON.stringify(parseListing('Item: Legacy Cape\nGolds: 33'));
        legacy.prepare(`INSERT INTO escrow_listing_terms
            (escrow_id,guild_id,channel_id,message_id,buyer_discord_id,seller_discord_id,item,quantity,method_key,
             unit_amount,payment_unit,total_amount,currency,listing_json,source_fingerprint)
            VALUES(1,'guild','channel','message','buyer','seller','Legacy Cape',2,'golds',33,'each',66,'Golds',?,?)`)
            .run(listingJson, 'a'.repeat(64));
        legacy.prepare(`INSERT INTO listing_request_sessions
            (token,guild_id,channel_id,message_id,buyer_discord_id,seller_discord_id,listing_json,source_fingerprint,created_at,expires_at)
            VALUES(?,'guild','channel','open-message','buyer','seller',?,?,100000,1000000)`)
            .run('c'.repeat(32), listingJson, 'a'.repeat(64));
        const before = legacy.prepare('SELECT * FROM escrow_listing_terms WHERE escrow_id=1').get();
        legacy.close();
        const migrated = child(`
            const assert=require('node:assert/strict');
            const {db,initDatabase}=require('./src/database/init');initDatabase();initDatabase();
            const r=require('./src/database/listingRepository');
            const row=r.getEscrowListingTerms(1);
            const before=${JSON.stringify(before)};
            for(const [key,value] of Object.entries(before)) assert.equal(row[key],value,key);
            assert.equal(row.product_key,null);assert.equal(row.bundle_quantity,1);
            assert.equal(row.bundle_unit,null);assert.equal(row.advertised_stock,null);
            assert.equal(row.source_content,null);
            const quote=r.getListingQuote('c'.repeat(32),{guildId:'guild',buyerDiscordId:'buyer',methodKey:'golds',quantity:2,now:100000});
            assert.equal(quote.payment.amount,66);assert.equal(quote.product.id,'p0');
            assert.equal(quote.session.source_content,null);
            assert.equal(db.prepare('SELECT item_description FROM escrow_transactions WHERE id=1').get().item_description,'Original description');
            assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
            db.close();
        `, filename);
        assert.equal(migrated.status, 0, migrated.stderr);
    } finally {
        if (legacy.open) legacy.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
