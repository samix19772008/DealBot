process.env.DATABASE_PATH = ':memory:';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { AttachmentBuilder } = require('discord.js');
const { createTranscriptService } = require('../src/services/transcripts');
const { createTranscriptDeliveryRepository, MAX_TRANSCRIPT_BYTES, LEASE_MS,
    DELIVERY_ATTEMPTS, GENERATION_ATTEMPTS } = require('../src/database/transcriptDeliveryRepository');

const databases = new Set();
const directories = new Set();
const buyerId = '110000000000000001';
const sellerId = '110000000000000002';
const guildId = '210000000000000001';
const threadId = '310000000000000001';
const archiveTimestamp = Date.UTC(2026, 9, 26, 12, 0, 0);
const initialNow = archiveTimestamp + 10000;
const logger = { error() {}, warn() {} };
const schema = () => fs.readFileSync(path.join(__dirname, '../src/database/schema.sql'), 'utf8');

after(() => {
    for (const database of databases) if (database.open) database.close();
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    const { db } = require('../src/database/init');
    if (db.open) db.close();
});

function fixture({ filename = ':memory:', generator } = {}) {
    const database = new Database(filename);
    databases.add(database);
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.exec(schema());
    database.prepare(`INSERT INTO users (id, discord_id, username, account_created_at)
        VALUES (1, ?, 'Buyer', '2020-01-01'), (2, ?, 'Seller', '2020-01-01')`).run(buyerId, sellerId);
    database.prepare(`INSERT INTO escrow_transactions
        (id, transaction_uuid, guild_id, channel_id, buyer_id, seller_id, item_description, amount, currency, payment_unit, status)
        VALUES (7, 'ESC-DURABLE', ?, ?, 1, 2, 'Cape', 33, 'Golds', 'each', 'completed')`).run(guildId, threadId);
    database.prepare(`INSERT INTO escrow_thread_closures
        (id, escrow_id, actor_discord_id, actor_name, kind, status, archive_timestamp)
        VALUES (1, 7, ?, 'Buyer', 'participant', 'archived', ?)`).run(buyerId, archiveTimestamp);
    let now = initialNow;
    const clock = () => now;
    const repository = createTranscriptDeliveryRepository({ database, clock });
    const sent = new Map([[buyerId, []], [sellerId, []]]);
    const calls = { generations: 0, sends: [], fetchedChannels: [] };
    const escrow = { id: 7, transaction_uuid: 'ESC-DURABLE', guild_id: guildId, channel_id: threadId,
        buyer_discord_id: buyerId, buyer_username: 'Buyer', seller_discord_id: sellerId, seller_username: 'Seller',
        item_description: 'Cape', amount: 33, currency: 'Golds', payment_unit: 'each', status: 'completed' };
    const closure = { id: 1, escrow_id: 7, actor_discord_id: buyerId, actor_name: 'Buyer', kind: 'participant',
        status: 'archived', archive_timestamp: archiveTimestamp };
    const client = { user: { displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
        users: { cache: new Map(), fetch: async id => ({ send: async payload => {
            calls.sends.push({ id, payload });
            sent.get(id).push(payload);
            return { id: String(410000000000000000n + BigInt(calls.sends.length)) };
        } }) } };
    const thread = { id: threadId, guildId, archived: true, archiveTimestamp,
        guild: { id: guildId, name: 'Private Market', iconURL: () => null }, client };
    client.channels = { fetch: async (id, options) => {
        calls.fetchedChannels.push({ id, options });
        return thread;
    } };
    const createTranscript = async (...args) => {
        calls.generations++;
        return generator ? generator(...args) : new AttachmentBuilder(Buffer.from('<html>Original closed conversation</html>'), { name: 'transcript-cape-7.html' });
    };
    function service(overrides = {}) {
        return createTranscriptService({ repository, clock, logger, createTranscript,
            findEscrow: () => escrow, recordArchive: () => closure, ...overrides });
    }
    return { database, repository, calls, sent, escrow, closure, client, thread, service, clock,
        setNow: value => { now = value; }, advance: amount => { now += amount; },
        archive: () => database.prepare('SELECT * FROM transcript_delivery_archives ORDER BY id').get(),
        recipients: () => database.prepare('SELECT * FROM transcript_delivery_recipients ORDER BY id').all() };
}

const embedData = payload => typeof payload.embeds?.[0]?.toJSON === 'function' ? payload.embeds[0].toJSON() : payload.embeds?.[0];

test('a successful archive persists its exact HTML and independent recipient acknowledgements', async () => {
    const f = fixture();
    f.escrow.vault_data = 'Unrelated private deal data';
    const result = await f.service().deliver(f.thread);
    assert.deepEqual(result.delivered, [buyerId, sellerId]);
    assert.equal(result.hasTranscript, true);
    const archive = f.archive();
    assert.equal(archive.generation_status, 'ready');
    assert.equal(archive.html.toString(), '<html>Original closed conversation</html>');
    assert.equal(Object.hasOwn(JSON.parse(archive.escrow_json), 'vault_data'), false);
    assert.equal(f.calls.generations, 1);
    for (const recipient of f.recipients()) {
        assert.equal(recipient.summary_delivered, 1);
        assert.equal(recipient.html_delivered, 1);
        assert.equal(recipient.status, 'delivered');
        assert.ok(recipient.last_message_id);
    }
    for (const { payload } of f.calls.sends) {
        assert.equal(payload.enforceNonce, true);
        assert.ok(typeof payload.nonce === 'string' && payload.nonce.length <= 25);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
    }
    assert.equal(new Set(f.calls.sends.map(call => call.payload.nonce)).size, 2);
});

test('a new service retries only the failed participant using the saved artifact, even if the source is gone', async () => {
    const f = fixture();
    let blocked = true;
    const normalFetch = f.client.users.fetch;
    f.client.users.fetch = async id => {
        if (id === buyerId && blocked) throw Object.assign(new Error('DMs closed'), { code: 50007 });
        return normalFetch(id);
    };
    const initial = await f.service().deliver(f.thread);
    assert.deepEqual(initial.failed, [buyerId]);
    assert.deepEqual(initial.delivered, [sellerId]);
    assert.equal(f.sent.get(sellerId).length, 1);
    assert.equal(f.sent.get(buyerId).length, 0);
    const failed = f.recipients().find(row => row.recipient_id === buyerId);
    assert.equal(failed.last_error, '50007');
    assert.ok(failed.next_attempt > f.clock());
    f.setNow(failed.next_attempt);
    blocked = false;
    f.client.channels.fetch = async () => assert.fail('A persisted transcript must not need its deleted source thread');
    await f.service().processQueue(f.client);
    assert.equal(f.calls.generations, 1);
    assert.equal(f.sent.get(sellerId).length, 1, 'A confirmed recipient must never be re-enqueued');
    assert.equal(f.sent.get(buyerId).length, 1);
    assert.equal(f.sent.get(buyerId)[0].files[0].attachment.toString(), '<html>Original closed conversation</html>');
    assert.ok(f.recipients().every(row => row.status === 'delivered'));
    await f.service().processQueue(f.client);
    assert.equal(f.sent.get(buyerId).length, 1);
});

test('failed generation sends an honest summary once, then a later worker sends only the recovered HTML', async () => {
    let failGeneration = true;
    const f = fixture({ generator: async () => {
        if (failGeneration) throw Object.assign(new Error('Temporary read failure'), { code: 'ETIMEDOUT' });
        return new AttachmentBuilder(Buffer.from('<html>Recovered original archive</html>'), { name: 'transcript-cape-7.html' });
    } });
    const initial = await f.service().deliver(f.thread);
    assert.equal(initial.hasTranscript, false);
    for (const id of [buyerId, sellerId]) {
        const [payload] = f.sent.get(id);
        assert.deepEqual(payload.files, []);
        assert.match(JSON.stringify(embedData(payload)), /could not be generated/);
    }
    assert.equal(f.archive().generation_status, 'pending');
    f.setNow(f.archive().generation_next_attempt);
    failGeneration = false;
    await f.service().processQueue(f.client);
    assert.equal(f.calls.generations, 2);
    for (const id of [buyerId, sellerId]) {
        const messages = f.sent.get(id);
        assert.equal(messages.length, 2);
        assert.equal(messages.filter(payload => payload.embeds?.length).length, 1, 'The summary is not sent again');
        assert.equal(messages[1].files[0].attachment.toString(), '<html>Recovered original archive</html>');
    }
    assert.ok(f.recipients().every(row => row.html_delivered === 1 && row.status === 'delivered'));
});

test('a retry never generates an old transcript from a reopened or differently archived conversation', async () => {
    for (const mutate of [thread => { thread.archived = false; }, thread => { thread.archiveTimestamp++; }]) {
        const f = fixture({ generator: async () => { throw new Error('Temporary generation failure'); } });
        await f.service().deliver(f.thread);
        assert.equal(f.calls.generations, 1);
        mutate(f.thread);
        f.setNow(f.archive().generation_next_attempt);
        await f.service().processQueue(f.client);
        assert.equal(f.calls.generations, 1);
        assert.equal(f.archive().generation_status, 'unavailable');
        assert.ok(f.recipients().every(row => row.summary_delivered === 1 && row.html_delivered === 0));
        assert.ok([...f.sent.values()].every(messages => messages.length === 1));
    }
});

test('oversized artifacts are not stored or attached and still produce truthful summaries', async () => {
    const f = fixture({ generator: async () => new AttachmentBuilder(Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1, 120), { name: 'too-big.html' }) });
    const result = await f.service().deliver(f.thread);
    assert.equal(result.hasTranscript, false);
    assert.equal(f.archive().html, null);
    assert.equal(f.archive().generation_status, 'unavailable');
    for (const messages of f.sent.values()) {
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0].files, []);
        assert.match(JSON.stringify(embedData(messages[0])), /exceeds the attachment size limit/);
    }
});

test('independent workers cannot generate or send a premature summary while another generation lease is active', async () => {
    let release;
    let started;
    const generated = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const f = fixture({ generator: async () => {
        started();
        await blocked;
        return new AttachmentBuilder(Buffer.from('<html>One archive</html>'), { name: 'transcript-cape-7.html' });
    } });
    const first = f.service().deliver(f.thread);
    await generated;
    await f.service().deliver(f.thread);
    assert.equal(f.calls.generations, 1);
    assert.equal(f.calls.sends.length, 0, 'The second worker must not call a pending generation a failure');
    release();
    await first;
    for (const messages of f.sent.values()) {
        assert.equal(messages.length, 1);
        assert.equal(messages[0].files.length, 1);
    }
});

test('expired worker claims can be recovered without allowing a stale worker to acknowledge another lease', async () => {
    const f = fixture({ generator: async () => { throw new Error('Offline'); } });
    await f.service().deliver(f.thread);
    const archiveId = f.archive().id;
    f.setNow(f.archive().generation_next_attempt);
    const first = f.repository.claimGeneration(archiveId, f.clock());
    assert.ok(first);
    assert.equal(f.repository.claimGeneration(archiveId, f.clock()), null);
    f.advance(LEASE_MS);
    const second = f.repository.claimGeneration(archiveId, f.clock());
    assert.ok(second);
    assert.notEqual(first.generation_lease_token, second.generation_lease_token);
    assert.equal(f.repository.finishGeneration(first, { html: Buffer.from('stale'), now: f.clock() }), false);
    assert.equal(f.repository.finishGeneration(second, { html: Buffer.from('current'), now: f.clock() }), true);
    assert.equal(f.archive().html.toString(), 'current');
});

test('retry budgets stop permanent delivery and generation failures without resetting after restarts', async () => {
    const f = fixture({ generator: async () => { throw new Error('Generator unavailable'); } });
    f.client.users.fetch = async () => { throw Object.assign(new Error('Closed DM'), { code: 50007 }); };
    await f.service().deliver(f.thread);
    for (let iteration = 0; iteration < 30; iteration++) {
        const archive = f.archive();
        const pending = f.recipients().filter(row => row.status === 'pending');
        const due = [archive.generation_status === 'pending' ? archive.generation_next_attempt : Infinity,
            ...pending.map(row => row.next_attempt)].filter(Number.isFinite);
        if (!due.length) break;
        f.setNow(Math.max(f.clock() + 1, Math.min(...due)));
        await f.service().processQueue(f.client);
    }
    assert.equal(f.archive().generation_status, 'unavailable');
    assert.equal(f.archive().generation_attempts, GENERATION_ATTEMPTS);
    assert.ok(f.recipients().every(row => row.status === 'exhausted' && row.attempts === DELIVERY_ATTEMPTS));
    const attempted = f.recipients().map(row => row.attempts);
    f.advance(7 * 86400000);
    await f.service().processQueue(f.client);
    assert.deepEqual(f.recipients().map(row => row.attempts), attempted);
});

test('upgrading or starting a worker does not turn historical archive rows into unsolicited deliveries', async () => {
    const f = fixture();
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures').get().count, 1);
    await f.service().processQueue(f.client);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM transcript_delivery_archives').get().count, 0);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.calls.generations, 0);
});

function runChild(code, filename) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'),
            env: { ...process.env, DATABASE_PATH: filename }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
}

test('pending generation and sent summaries survive a new process and simultaneous SQLite workers get one lease', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-transcript-queue-'));
    directories.add(directory);
    const filename = path.join(directory, 'delivery.sqlite');
    const f = fixture({ filename, generator: async () => { throw new Error('Offline'); } });
    await f.service().deliver(f.thread);
    const archiveId = f.archive().id;
    const at = f.archive().generation_next_attempt;
    f.database.close();
    const code = `
        const {db}=require('./src/database/init');
        const {createTranscriptDeliveryRepository}=require('./src/database/transcriptDeliveryRepository');
        const repository=createTranscriptDeliveryRepository({database:db});
        const job=repository.claimGeneration(${archiveId},${at});
        console.log(job ? 'claimed' : 'busy');
        db.close();
    `;
    const results = await Promise.all(Array.from({ length: 4 }, () => runChild(code, filename)));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.equal(results.filter(result => result.stdout.trim() === 'claimed').length, 1);
    assert.equal(results.filter(result => result.stdout.trim() === 'busy').length, 3);
    const reopened = new Database(filename);
    databases.add(reopened);
    assert.equal(reopened.prepare('SELECT generation_attempts FROM transcript_delivery_archives WHERE id = ?').get(archiveId).generation_attempts, 2);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM transcript_delivery_recipients WHERE summary_delivered = 1').get().count, 2);
});

test('a fresh Node process delivers only the failed recipient from a saved HTML artifact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealbot-transcript-restart-'));
    directories.add(directory);
    const filename = path.join(directory, 'delivery.sqlite');
    const f = fixture({ filename });
    const normalFetch = f.client.users.fetch;
    f.client.users.fetch = async id => {
        if (id === buyerId) throw Object.assign(new Error('Closed DM'), { code: 50007 });
        return normalFetch(id);
    };
    await f.service().deliver(f.thread);
    assert.equal(f.archive().generation_status, 'ready');
    assert.equal(f.sent.get(sellerId).length, 1);
    const due = f.recipients().find(row => row.recipient_id === buyerId).next_attempt;
    f.database.close();
    const result = await runChild(`
        (async () => {
            const {db}=require('./src/database/init');
            const {createTranscriptService}=require('./src/services/transcripts');
            const {createTranscriptDeliveryRepository}=require('./src/database/transcriptDeliveryRepository');
            const sent=[];
            const client={users:{cache:new Map(),fetch:async id=>({send:async payload=>{
                sent.push({id,html:payload.files[0].attachment.toString()});
                return{id:'410000000000000999'};
            }})},channels:{fetch:async()=>{throw new Error('Saved artifact must not reread source');}}};
            const service=createTranscriptService({repository:createTranscriptDeliveryRepository({database:db}),
                clock:()=>${due},createTranscript:async()=>{throw new Error('Saved artifact must not regenerate');},
                logger:{warn(){},error(){}}});
            await service.processQueue(client);
            await service.waitForIdle();
            console.log(JSON.stringify(sent));
            db.close();
        })().catch(error=>{console.error(error);process.exitCode=1;});
    `, filename);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ id: buyerId, html: '<html>Original closed conversation</html>' }]);
    const reopened = new Database(filename);
    databases.add(reopened);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM transcript_delivery_recipients WHERE status='delivered' AND html_delivered=1").get().count, 2);
    assert.equal(reopened.prepare('SELECT generation_attempts FROM transcript_delivery_archives').get().generation_attempts, 1);
});

test('recording a new archive atomically queues work that a restart can recover before its event handler ran', async () => {
    const { db } = require('../src/database/init');
    const users = require('../src/database/userRepository');
    const escrows = require('../src/database/escrowRepository');
    const { recordThreadArchive } = require('../src/database/transcriptRepository');
    const buyer = users.getOrCreateUser({ id: buyerId, tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = users.getOrCreateUser({ id: sellerId, tag: 'Seller', createdAt: new Date('2020-01-01') });
    const deal = escrows.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id, itemDescription: 'Cape', amount: 33,
        currency: 'Golds', paymentUnit: 'each' });
    escrows.acceptEscrow(deal.id, threadId, sellerId);
    const closed = recordThreadArchive(deal.id, archiveTimestamp);
    const queued = db.prepare('SELECT * FROM transcript_delivery_archives WHERE closure_id = ?').get(closed.id);
    assert.ok(queued, 'The archive record and outbox must commit before the asynchronous delivery event');
    assert.equal(queued.summary_json, '{}');
    assert.equal(queued.generation_status, 'pending');
    const f = fixture();
    const service = createTranscriptService({ repository: createTranscriptDeliveryRepository({ database: db }),
        clock: () => Math.max(initialNow, queued.generation_next_attempt), logger,
        createTranscript: async () => new AttachmentBuilder(Buffer.from('<html>Recovered after interrupted event</html>'), { name: 'closed.html' }) });
    await service.processQueue(f.client);
    assert.ok([...f.sent.values()].every(messages => messages.length === 1));
    assert.equal(db.prepare('SELECT html FROM transcript_delivery_archives WHERE id = ?').get(queued.id).html.toString(), '<html>Recovered after interrupted event</html>');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transcript_delivery_recipients WHERE archive_id = ? AND status='delivered'").get(queued.id).count, 2);
});

test('a failed outbox insertion rolls back the matching archive record instead of losing delivery work', () => {
    const { db } = require('../src/database/init');
    const users = require('../src/database/userRepository');
    const escrows = require('../src/database/escrowRepository');
    const { recordThreadArchive } = require('../src/database/transcriptRepository');
    const buyer = users.getOrCreateUser({ id: buyerId, tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = users.getOrCreateUser({ id: sellerId, tag: 'Seller', createdAt: new Date('2020-01-01') });
    const deal = escrows.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id, itemDescription: 'Cape', amount: 33,
        currency: 'Golds', paymentUnit: 'each' });
    escrows.acceptEscrow(deal.id, '310000000000000009', sellerId);
    db.exec(`CREATE TEMP TRIGGER block_new_transcript_queue BEFORE INSERT ON transcript_delivery_archives
        BEGIN SELECT RAISE(ABORT, 'Simulated queue write failure'); END;`);
    try {
        assert.throws(() => recordThreadArchive(deal.id, archiveTimestamp + 1000), /Simulated queue write failure/);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_thread_closures WHERE escrow_id = ?').get(deal.id).count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_delivery_archives WHERE escrow_id = ?').get(deal.id).count, 0);
    } finally { db.exec('DROP TRIGGER block_new_transcript_queue'); }
    recordThreadArchive(deal.id, archiveTimestamp + 1000);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_delivery_archives WHERE escrow_id = ?').get(deal.id).count, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('legacy archive metadata without a saved thread remains valid and does not invent a delivery source', () => {
    const { db } = require('../src/database/init');
    const users = require('../src/database/userRepository');
    const escrows = require('../src/database/escrowRepository');
    const { recordThreadArchive } = require('../src/database/transcriptRepository');
    const buyer = users.getOrCreateUser({ id: buyerId, tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = users.getOrCreateUser({ id: sellerId, tag: 'Seller', createdAt: new Date('2020-01-01') });
    const deal = escrows.createEscrow({ guildId: `${guildId}-legacy`, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Legacy metadata record', amount: 2 });
    assert.equal(deal.channel_id, null);
    const closure = recordThreadArchive(deal.id, archiveTimestamp + 2000);
    assert.equal(closure.status, 'archived');
    assert.equal(closure.archive_timestamp, archiveTimestamp + 2000);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transcript_delivery_archives WHERE escrow_id = ?').get(deal.id).count, 0);
});

test('an archive observed during shutdown is persisted without starting generation or sending messages', async () => {
    const f = fixture();
    f.client.dealBotStopping = true;
    assert.deepEqual(await f.service().deliver(f.thread), { queued: true });
    assert.equal(f.archive().generation_status, 'pending');
    assert.equal(f.archive().generation_attempts, 0);
    assert.equal(f.calls.generations, 0);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.recipients().length, 2);
    assert.ok(f.recipients().every(row => row.attempts === 0 && row.status === 'pending'));
    f.client.dealBotStopping = false;
    await f.service().processQueue(f.client);
    assert.equal(f.calls.generations, 1);
    assert.ok(f.recipients().every(row => row.status === 'delivered'));
});

test('shutdown after a user lookup releases the delivery claim without spending an attempt or sending a DM', async () => {
    const f = fixture();
    const normalFetch = f.client.users.fetch;
    f.client.users.fetch = async id => {
        f.client.dealBotStopping = true;
        return normalFetch(id);
    };
    await f.service().deliver(f.thread);
    assert.equal(f.archive().generation_status, 'ready');
    assert.equal(f.calls.sends.length, 0);
    assert.ok(f.recipients().every(row => row.attempts === 0 && row.lease_token === null && row.status === 'pending'));
    f.client.dealBotStopping = false;
    f.client.users.fetch = normalFetch;
    await f.service().processQueue(f.client);
    assert.equal(f.calls.generations, 1, 'Restart uses the previously captured artifact');
    assert.equal(f.calls.sends.length, 2);
    assert.ok(f.recipients().every(row => row.attempts === 1 && row.status === 'delivered'));
});

test('shutdown after a source lookup releases generation so the next worker can retry immediately', async () => {
    const f = fixture();
    const normalFetch = f.client.channels.fetch;
    f.client.channels.fetch = async (...args) => {
        f.client.dealBotStopping = true;
        return normalFetch(...args);
    };
    await f.service().deliver(f.thread);
    assert.equal(f.calls.generations, 0);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.archive().generation_status, 'pending');
    assert.equal(f.archive().generation_attempts, 0);
    assert.equal(f.archive().generation_lease_token, null);
    assert.equal(f.archive().generation_next_attempt, f.clock());
    f.client.dealBotStopping = false;
    f.client.channels.fetch = normalFetch;
    await f.service().processQueue(f.client);
    assert.equal(f.calls.generations, 1);
    assert.ok(f.recipients().every(row => row.status === 'delivered'));
});
