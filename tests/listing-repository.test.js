const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

process.env.DATABASE_PATH = ':memory:';
const { db, initDatabase } = require('../src/database/init');
const repository = require('../src/database/listingRepository');
const { parseListing } = require('../src/utils/listings');
const { createEscrow } = require('../src/database/escrowRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
const project = path.join(__dirname, '..');
let sequence = 0;

after(() => db.close());

function fixture(content = 'Item: Menace Cape\nGolds: 33', options = {}) {
    const suffix = ++sequence;
    const now = options.now ?? 100000;
    const buyer = getOrCreateUser({ id: `listing-buyer-${suffix}`, tag: `Buyer ${suffix}`, createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: `listing-seller-${suffix}`, tag: `Seller ${suffix}`, createdAt: new Date('2020-01-01') });
    const params = { guildId: `listing-guild-${suffix}`, channelId: `listing-channel-${suffix}`, messageId: `listing-message-${suffix}`,
        buyerDiscordId: buyer.discord_id, sellerDiscordId: seller.discord_id,
        listing: parseListing(content), sourceFingerprint: 'a'.repeat(64), now, ...options };
    const session = repository.createListingRequest(params);
    const request = { guildId: params.guildId, buyerDiscordId: params.buyerDiscordId, methodKey: params.listing.options[0].key,
        quantity: 2, now };
    return { params, session, request, buyer, seller };
}

function pendingEscrow(f, request = {}) {
    const quote = repository.getListingQuote(f.session.token, { ...f.request, ...request });
    const escrow = createEscrow({ guildId: f.params.guildId, buyerId: f.buyer.id, sellerId: f.seller.id,
        itemDescription: quote.itemDescription, ...quote.payment });
    const consume = { token: f.session.token, ...f.request, ...request, sellerDiscordId: f.seller.discord_id, ...quote.payment };
    return { quote, escrow, consume };
}

function child(script, filename) {
    return spawnSync(process.execPath, ['-e', script], { cwd: project,
        env: { ...process.env, DATABASE_PATH: filename }, encoding: 'utf8' });
}

function asyncChild(script, filename) {
    return new Promise((resolve, reject) => {
        const process = spawn(global.process.execPath, ['-e', script], { cwd: project,
            env: { ...global.process.env, DATABASE_PATH: filename }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        process.stdout.on('data', data => { stdout += data; });
        process.stderr.on('data', data => { stderr += data; });
        process.on('error', reject);
        process.on('close', status => resolve({ status, stdout, stderr }));
    });
}

test('listing sessions have unpredictable tokens, immutable snapshots, and a fifteen-minute deadline', () => {
    const f = fixture();
    assert.match(f.session.token, /^[a-f0-9]{32}$/);
    assert.equal(f.session.created_at, 100000);
    assert.equal(f.session.expires_at, 100000 + repository.LISTING_REQUEST_TTL_MS);
    assert.notEqual(f.session.token, fixture().session.token);
    f.params.listing.item = 'Changed caller object';
    f.params.listing.options[0].amount = 1;
    f.session.listing.options[0].amount = 2;
    const stored = repository.getListingRequest(f.session.token, f.request);
    assert.equal(stored.listing.item, 'Menace Cape');
    assert.equal(stored.listing.options[0].amount, 33);
    assert.equal(repository.getListingRequest(f.session.token, { ...f.request, now: f.session.expires_at - 1 }).token, f.session.token);
    assert.throws(() => repository.getListingRequest(f.session.token, { ...f.request, now: f.session.expires_at }), /expired/);
});

test('listing requests are bound to their server and buyer and reject malformed identities and timestamps', () => {
    const f = fixture();
    for (const override of [{ guildId: 'other-server' }, { buyerDiscordId: f.seller.discord_id }, { guildId: null }]) {
        assert.throws(() => repository.getListingRequest(f.session.token, { ...f.request, ...override }), { code: 'LISTING_REQUEST_INVALID' });
    }
    for (const token of ['', 'a'.repeat(31), 'A'.repeat(32), 'not-a-token']) {
        assert.throws(() => repository.getListingRequest(token, f.request), { code: 'LISTING_REQUEST_INVALID' });
    }
    for (const now of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => repository.createListingRequest({ ...f.params, now }), /timestamp/);
    }
    assert.throws(() => repository.createListingRequest({ ...f.params, channelId: '../private' }), /channel ID/);
    assert.throws(() => repository.createListingRequest({ ...f.params, sellerDiscordId: f.buyer.discord_id }), /yourself/);
    assert.throws(() => repository.createListingRequest({ ...f.params, sourceFingerprint: 'unknown' }), /fingerprint/);
});

test('quotes offer only saved methods and multiply a fixed seller price by quantity', () => {
    const f = fixture();
    const quote = repository.getListingQuote(f.session.token, f.request);
    assert.equal(quote.payment.amount, 66);
    assert.equal(quote.payment.currency, 'Golds');
    assert.equal(quote.payment.unitAmount, 33);
    assert.equal(quote.payment.quantity, 2);
    assert.match(quote.itemDescription, /^Menace Cape\nQuantity: 2\nUnit price: 33 Golds\nSource: https:\/\/discord\.com\/channels\//);
    assert.throws(() => repository.getListingQuote(f.session.token, { ...f.request, methodKey: 'money' }), /offered/);
    for (const quantity of [0, -1, 1.5, 1000, '2e1', '2 gold', '']) {
        assert.throws(() => repository.getListingQuote(f.session.token, { ...f.request, quantity }), /quantity/);
    }
});

test('saved money and stack quotes retain exact cents and payment units', () => {
    const f = fixture('Item: Cape\nMoney: $0.10\nRedblocks: 20 stacks');
    const money = repository.getListingQuote(f.session.token, { ...f.request, methodKey: 'money', quantity: 3 });
    assert.equal(money.payment.amount, 0.3);
    const stacks = repository.getListingQuote(f.session.token, { ...f.request, methodKey: 'redblocks', quantity: 2 });
    assert.equal(stacks.payment.amount, 40);
    assert.equal(stacks.payment.paymentUnit, 'stacks');
    assert.match(stacks.itemDescription, /Unit price: 20 stacks of Redblocks \(1,280 blocks\)/);
});

test('consumption stores immutable listing terms and prevents duplicate deal submissions', () => {
    const f = fixture();
    const { escrow, consume } = pendingEscrow(f);
    const terms = repository.consumeListingRequest(escrow.id, consume);
    assert.equal(terms.escrow_id, escrow.id);
    assert.equal(terms.quantity, 2);
    assert.equal(terms.unit_amount, 33);
    assert.equal(terms.total_amount, 66);
    assert.equal(terms.source_fingerprint, f.params.sourceFingerprint);
    assert.equal(terms.message_id, f.params.messageId);
    assert.equal(terms.seller_discord_id, f.seller.discord_id);
    assert.equal(terms.item, 'Menace Cape');
    assert.equal(db.prepare('SELECT consumed_escrow_id FROM listing_request_sessions WHERE token = ?').get(f.session.token).consumed_escrow_id, escrow.id);
    assert.throws(() => repository.getListingRequest(f.session.token, f.request), /already been submitted/);
    assert.throws(() => repository.consumeListingRequest(escrow.id, consume), /already been submitted/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_listing_terms WHERE escrow_id = ?').get(escrow.id).count, 1);
    initDatabase();
    assert.equal(repository.getEscrowListingTerms(escrow.id).total_amount, 66);
});

test('the final write rejects forged amounts, payment units and sellers without consuming the form', () => {
    const f = fixture();
    const { escrow, consume } = pendingEscrow(f);
    for (const override of [{ amount: 65 }, { amount: 67 }, { currency: 'USD' }, { paymentUnit: 'stacks' },
        { sellerDiscordId: 'different-seller' }, { quantity: 3 }, { methodKey: 'money' }]) {
        assert.throws(() => repository.consumeListingRequest(escrow.id, { ...consume, ...override }));
        assert.equal(repository.getEscrowListingTerms(escrow.id), undefined);
        assert.equal(repository.getListingRequest(f.session.token, f.request).consumed_escrow_id, null);
    }
    assert.equal(repository.consumeListingRequest(escrow.id, consume).total_amount, 66);
});

test('the persisted escrow must match source terms, participants and server', () => {
    const f = fixture();
    const { escrow, consume } = pendingEscrow(f);
    for (const [column, value] of [['item_description', 'Other item'], ['guild_id', 'other-server'], ['amount', 5], ['status', 'cancelled']]) {
        const original = db.prepare(`SELECT ${column} AS value FROM escrow_transactions WHERE id = ?`).get(escrow.id).value;
        db.prepare(`UPDATE escrow_transactions SET ${column} = ? WHERE id = ?`).run(value, escrow.id);
        assert.throws(() => repository.consumeListingRequest(escrow.id, consume), /does not match/);
        db.prepare(`UPDATE escrow_transactions SET ${column} = ? WHERE id = ?`).run(original, escrow.id);
    }
    assert.equal(repository.consumeListingRequest(escrow.id, consume).escrow_id, escrow.id);
});

test('an expired form cannot be consumed even when a valid quote was previously displayed', () => {
    const f = fixture();
    const { escrow, consume } = pendingEscrow(f);
    assert.throws(() => repository.consumeListingRequest(escrow.id, { ...consume, now: f.session.expires_at }), /expired/);
    assert.equal(repository.getEscrowListingTerms(escrow.id), undefined);
    assert.equal(db.prepare('SELECT consumed_escrow_id FROM listing_request_sessions WHERE token = ?').get(f.session.token).consumed_escrow_id, null);
});

test('a terms write failure rolls form consumption back, allowing a safe retry', () => {
    const f = fixture();
    const { escrow, consume } = pendingEscrow(f);
    db.exec(`CREATE TEMP TRIGGER fail_listing_terms BEFORE INSERT ON escrow_listing_terms
        BEGIN SELECT RAISE(ABORT, 'Terms write failure'); END;`);
    try {
        assert.throws(() => repository.consumeListingRequest(escrow.id, consume), /Terms write failure/);
        assert.equal(repository.getListingRequest(f.session.token, f.request).consumed_escrow_id, null);
        assert.equal(repository.getEscrowListingTerms(escrow.id), undefined);
    } finally { db.exec('DROP TRIGGER fail_listing_terms'); }
    assert.equal(repository.consumeListingRequest(escrow.id, consume).escrow_id, escrow.id);
});

test('an outer deal transaction rolls back its escrow insert when listing validation fails', () => {
    const f = fixture();
    const quote = repository.getListingQuote(f.session.token, f.request);
    const before = db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count;
    const attempt = db.transaction(() => {
        const escrow = createEscrow({ guildId: f.params.guildId, buyerId: f.buyer.id, sellerId: f.seller.id,
            itemDescription: quote.itemDescription, ...quote.payment });
        repository.consumeListingRequest(escrow.id, { token: f.session.token, ...f.request, sellerDiscordId: f.seller.discord_id,
            ...quote.payment, amount: 1 });
    });
    assert.throws(() => attempt.immediate(), /does not match/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, before);
    assert.equal(repository.getListingRequest(f.session.token, f.request).consumed_escrow_id, null);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('invalid or inconsistent listing snapshots cannot be stored', () => {
    const f = fixture();
    for (const listing of [null, { item: 'Cape', options: [] }, { item: 'Cape', options: [{ key: 'golds', amount: 33, currency: 'USD' }] },
        { item: 'Cape', options: [{ key: 'unknown', amount: 33, currency: 'Unknown' }] },
        { item: 'Cape\nMoney: 1', options: [f.params.listing.options[0]] },
        { item: 'Cape', options: [f.params.listing.options[0], f.params.listing.options[0]] }]) {
        assert.throws(() => repository.createListingRequest({ ...f.params, listing }));
    }
});

function listingCreateParameters(f, requestOverrides = {}, escrowOverrides = {}) {
    const request = { ...f.request, ...requestOverrides };
    const quote = repository.getListingQuote(f.session.token, request);
    return { guildId: f.params.guildId, buyerId: f.buyer.id, sellerId: f.seller.id,
        itemDescription: quote.itemDescription, ...quote.payment,
        listingRequest: { token: f.session.token, methodKey: request.methodKey, quantity: request.quantity, now: request.now },
        ...escrowOverrides };
}

test('createEscrow commits the deal, saved terms, consumption and audit together and rejects replay', () => {
    const f = fixture();
    const parameters = listingCreateParameters(f);
    // Identity and totals are derived from the real escrow row, regardless of
    // extra fields supplied in a request object by another internal caller.
    Object.assign(parameters.listingRequest, { guildId: 'wrong', buyerDiscordId: 'wrong', sellerDiscordId: 'wrong',
        amount: 1, currency: 'USD', paymentUnit: 'stacks' });
    const escrow = createEscrow(parameters);
    const terms = repository.getEscrowListingTerms(escrow.id);
    assert.equal(terms.quantity, 2);
    assert.equal(terms.total_amount, 66);
    assert.equal(terms.guild_id, f.params.guildId);
    assert.equal(terms.buyer_discord_id, f.buyer.discord_id);
    assert.equal(terms.seller_discord_id, f.seller.discord_id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM escrow_events WHERE escrow_id = ? AND event_type = 'created'")
        .get(escrow.id).count, 1);
    const before = db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count;
    assert.throws(() => createEscrow(parameters), { code: 'LISTING_REQUEST_INVALID' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, before);
    assert.equal(db.prepare('SELECT consumed_escrow_id FROM listing_request_sessions WHERE token = ?')
        .get(f.session.token).consumed_escrow_id, escrow.id);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('createEscrow rejects a price or participant mismatch without leaving an inserted deal', () => {
    const f = fixture();
    const parameters = listingCreateParameters(f);
    const before = db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count;
    for (const overrides of [{ amount: 65 }, { amount: 67 }, { currency: 'USD' }, { paymentUnit: 'stacks' },
        { itemDescription: 'Different product' }, { guildId: 'different-guild' }, { buyerId: f.seller.id, sellerId: f.buyer.id }]) {
        assert.throws(() => createEscrow({ ...parameters, ...overrides }), { code: 'LISTING_REQUEST_INVALID' });
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, before);
        assert.equal(repository.getListingRequest(f.session.token, f.request).consumed_escrow_id, null);
    }
    assert.ok(createEscrow(parameters).id);
});

test('a final expiry check rolls back createEscrow after a previously valid quote', () => {
    const f = fixture();
    const parameters = listingCreateParameters(f);
    parameters.listingRequest.now = f.session.expires_at;
    const before = db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count;
    assert.throws(() => createEscrow(parameters), { code: 'LISTING_REQUEST_INVALID' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, before);
    assert.equal(db.prepare('SELECT consumed_escrow_id FROM listing_request_sessions WHERE token = ?')
        .get(f.session.token).consumed_escrow_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_listing_terms WHERE message_id = ?')
        .get(f.params.messageId).count, 0);
});

test('an audit failure after consuming a listing rolls back its new deal and terms for retry', () => {
    const f = fixture();
    const parameters = listingCreateParameters(f);
    const before = db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count;
    db.exec(`CREATE TEMP TRIGGER fail_listing_create_audit BEFORE INSERT ON escrow_events
        WHEN NEW.event_type = 'created' BEGIN SELECT RAISE(ABORT, 'Listing audit failure'); END;`);
    try {
        assert.throws(() => createEscrow(parameters), /Listing audit failure/);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, before);
        assert.equal(repository.getListingRequest(f.session.token, f.request).consumed_escrow_id, null);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_listing_terms WHERE message_id = ?')
            .get(f.params.messageId).count, 0);
    } finally { db.exec('DROP TRIGGER fail_listing_create_audit'); }
    assert.equal(repository.getEscrowListingTerms(createEscrow(parameters).id).total_amount, 66);
});

test('a listing snapshot survives process restarts and simultaneous workers consume it only once', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-listing-race-'));
    const filename = path.join(directory, 'listings.sqlite');
    try {
        const prepared = child(`
            const r = require('./src/database/listingRepository');
            const { parseListing } = require('./src/utils/listings');
            const u = require('./src/database/userRepository');
            const buyer = u.getOrCreateUser({id: 'buyer', tag: 'Buyer', createdAt: new Date('2020-01-01')});
            const seller = u.getOrCreateUser({id: 'seller', tag: 'Seller', createdAt: new Date('2020-01-01')});
            const session = r.createListingRequest({guildId:'guild',channelId:'channel',messageId:'message',buyerDiscordId:'buyer',
                sellerDiscordId:'seller',listing:parseListing('Item: Cape\\nGolds: 33'),sourceFingerprint:'a'.repeat(64),now:100000});
            const request = {guildId:'guild',buyerDiscordId:'buyer',methodKey:'golds',quantity:2,now:100000};
            const quote = r.getListingQuote(session.token,request);
            const escrow = require('./src/database/escrowRepository').createEscrow({guildId:'guild',buyerId:buyer.id,sellerId:seller.id,
                itemDescription:quote.itemDescription,...quote.payment});
            console.log(JSON.stringify({token:session.token,escrowId:escrow.id,options:{token:session.token,...request,
                sellerDiscordId:'seller',...quote.payment}}));
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(prepared.status, 0, prepared.stderr);
        const payload = JSON.parse(prepared.stdout);
        const results = await Promise.all(Array.from({ length: 4 }, () => asyncChild(`
            const r = require('./src/database/listingRepository');
            const payload = ${JSON.stringify(payload)};
            try { r.consumeListingRequest(payload.escrowId,payload.options); console.log('consumed'); }
            catch(error) { if(error.code !== 'LISTING_REQUEST_INVALID') throw error; console.log('already-used'); }
            require('./src/database/init').db.close();
        `, filename)));
        for (const result of results) assert.equal(result.status, 0, result.stderr);
        assert.equal(results.filter(result => result.stdout.trim() === 'consumed').length, 1);
        assert.equal(results.filter(result => result.stdout.trim() === 'already-used').length, 3);
        const restarted = child(`
            const r = require('./src/database/listingRepository');
            console.log(JSON.stringify(r.getEscrowListingTerms(${payload.escrowId})));
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(restarted.status, 0, restarted.stderr);
        assert.equal(JSON.parse(restarted.stdout).total_amount, 66);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('simultaneous createEscrow submissions insert exactly one deal and one source snapshot', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-listing-create-race-'));
    const filename = path.join(directory, 'listings.sqlite');
    try {
        const prepared = child(`
            const r = require('./src/database/listingRepository');
            const { parseListing } = require('./src/utils/listings');
            const u = require('./src/database/userRepository');
            const buyer = u.getOrCreateUser({id:'buyer',tag:'Buyer',createdAt:new Date('2020-01-01')});
            const seller = u.getOrCreateUser({id:'seller',tag:'Seller',createdAt:new Date('2020-01-01')});
            const session = r.createListingRequest({guildId:'guild',channelId:'channel',messageId:'message',buyerDiscordId:'buyer',
                sellerDiscordId:'seller',listing:parseListing('Item: Cape\\nGolds: 33'),sourceFingerprint:'a'.repeat(64),now:100000});
            const quote = r.getListingQuote(session.token,{guildId:'guild',buyerDiscordId:'buyer',methodKey:'golds',quantity:2,now:100000});
            console.log(JSON.stringify({token:session.token,parameters:{guildId:'guild',buyerId:buyer.id,sellerId:seller.id,
                itemDescription:quote.itemDescription,...quote.payment,
                listingRequest:{token:session.token,methodKey:'golds',quantity:2,now:100000}}}));
            require('./src/database/init').db.close();
        `, filename);
        assert.equal(prepared.status, 0, prepared.stderr);
        const payload = JSON.parse(prepared.stdout);
        const results = await Promise.all(Array.from({ length: 4 }, () => asyncChild(`
            const { createEscrow } = require('./src/database/escrowRepository');
            const payload = ${JSON.stringify(payload)};
            try { console.log(JSON.stringify({created:createEscrow(payload.parameters).id})); }
            catch(error) { if(error.code !== 'LISTING_REQUEST_INVALID') throw error; console.log(JSON.stringify({rejected:true})); }
            require('./src/database/init').db.close();
        `, filename)));
        for (const result of results) assert.equal(result.status, 0, result.stderr);
        const outcomes = results.map(result => JSON.parse(result.stdout));
        assert.equal(outcomes.filter(result => result.created).length, 1);
        assert.equal(outcomes.filter(result => result.rejected).length, 3);
        const restarted = child(`
            const { db } = require('./src/database/init');
            const assert = require('node:assert/strict');
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count,1);
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_listing_terms').get().count,1);
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_events').get().count,1);
            const escrow = db.prepare('SELECT * FROM escrow_transactions').get();
            const terms = require('./src/database/listingRepository').getEscrowListingTerms(escrow.id);
            assert.equal(escrow.amount,66); assert.equal(terms.total_amount,66); assert.equal(terms.quantity,2);
            assert.equal(db.prepare('SELECT consumed_escrow_id FROM listing_request_sessions WHERE token = ?')
                .get(${JSON.stringify(payload.token)}).consumed_escrow_id,escrow.id);
            assert.deepEqual(db.pragma('foreign_key_check'),[]);
            db.close();
        `, filename);
        assert.equal(restarted.status, 0, restarted.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
