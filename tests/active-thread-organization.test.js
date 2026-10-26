process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ChannelType } = require('discord.js');
const { db } = require('../src/database/init');
const deals = require('../src/database/escrowRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
const { setActiveThreadIdleMinutes } = require('../src/database/guildSettingsRepository');
const { processingDeals } = require('../src/utils/dealLocks');
const { processActiveThreadOrganization, startActiveThreadOrganization } = require('../src/services/activeThreadOrganization');

let sequence = 0;
const unique = label => `${label}-${++sequence}`;
beforeEach(() => db.exec('SAVEPOINT active_worker_test'));
afterEach(() => { processingDeals.clear(); db.exec('ROLLBACK TO active_worker_test; RELEASE active_worker_test'); });
after(() => db.close());

function fixture({ status = 'funded', activityAge = 3600000, archived = false, policy,
    parentAllowed = true, threadAllowed = true, type = ChannelType.PrivateThread } = {}) {
    const now = Date.now();
    const guildId = unique('active-worker-guild');
    const buyer = getOrCreateUser({ id: unique('buyer'), tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: unique('seller'), tag: 'Seller', createdAt: new Date('2020-01-01') });
    let escrow = deals.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Menace Cape', amount: 2, currency: 'USD' });
    if (status !== 'pending') deals.acceptEscrow(escrow.id, unique('active-worker-thread'), seller.discord_id);
    if (['funded', 'delivered', 'completed', 'disputed', 'cancelled', 'refunded'].includes(status)) deals.markAsFunded(escrow.id, buyer.discord_id);
    if (['delivered', 'completed'].includes(status)) deals.markAsDelivered(escrow.id, seller.discord_id);
    if (status === 'completed') deals.completeEscrow(escrow.id, buyer.id, seller.id, buyer.discord_id);
    if (['disputed', 'cancelled'].includes(status)) {
        deals.markAsDisputed(escrow.id, 'The delivery needs a moderator review.', buyer.discord_id);
        if (status === 'cancelled') deals.cancelEscrow(escrow.id, { expectedStatus: 'disputed', actorId: seller.discord_id });
    }
    if (status === 'refunded') db.prepare("UPDATE escrow_transactions SET status = 'refunded' WHERE id = ?").run(escrow.id);
    db.prepare('UPDATE escrow_transactions SET updated_at = ? WHERE id = ?').run(new Date(now - 3600000).toISOString(), escrow.id);
    escrow = deals.getEscrowById(escrow.id);
    if (policy != null) setActiveThreadIdleMinutes(guildId, policy);
    const calls = [];
    const bot = { id: 'active-worker-bot', bot: true };
    const guild = { id: guildId };
    const botMember = { id: bot.id, guild };
    const parent = { id: unique('hub'), guildId, type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => parentAllowed }) };
    const thread = { id: escrow.channel_id, guildId, parentId: parent.id, type, archived, locked: false,
        archiveTimestamp: now - 3600000, lastMessageId: 'latest',
        permissionsFor: () => ({ has: () => threadAllowed }),
        messages: { fetch: async options => {
            calls.push(['messages', options]);
            return new Map([['latest', { id: 'latest', createdTimestamp: now - activityAge }]]);
        } },
        setLocked: async () => assert.fail('Idle organization must never change staff locks'),
        setArchived: async value => {
            calls.push(['archive', value]); thread.archived = value; thread.archiveTimestamp = Date.now(); return thread;
        },
    };
    guild.channels = { fetch: async (id, options) => {
        calls.push(['fetch', id, options]);
        return id === parent.id ? parent : id === thread.id ? thread : null;
    } };
    guild.members = { fetchMe: async () => botMember };
    const client = { user: bot, guilds: { fetch: async id => id === guild.id ? guild : null },
        emit: () => assert.fail('Idle organization must not emit transcript archive events') };
    return { now, guild, client, thread, parent, calls, escrow, buyer, seller };
}

function run(f, options) { return processActiveThreadOrganization(f.client, { onError: () => {}, ...options }); }
function savedJob(f) { return db.prepare('SELECT * FROM deal_active_thread_cleanup WHERE escrow_id = ?').get(f.escrow.id); }
function archives(f) { return f.calls.filter(call => call[0] === 'archive'); }

test('idle active conversations are archived without locks, status changes, closure records, or transcripts', async () => {
    const f = fixture();
    assert.equal((await run(f)).hidden, 1);
    assert.deepEqual(archives(f).map(call => call[1]), [true]);
    assert.equal(f.thread.locked, false);
    assert.equal(savedJob(f).status, 'archived');
    assert.equal(deals.getEscrowById(f.escrow.id).status, 'funded');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escrow_thread_closures WHERE escrow_id = ?').get(f.escrow.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcript_delivery_archives WHERE escrow_id = ?').get(f.escrow.id).n, 0);
    const events = deals.getEscrowEvents(f.escrow.id).filter(event => event.event_type === 'thread_idle_archived');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_discord_id, f.client.user.id);
    assert.equal((await run(f)).claimed, 0);
    assert.equal(archives(f).length, 1);
});

test('payment, delivery, and receipt stages remain resumable active states after hiding', async () => {
    for (const status of ['awaiting_payment', 'funded', 'delivered']) {
        const f = fixture({ status });
        assert.equal((await run(f)).hidden, 1);
        assert.equal(deals.getEscrowById(f.escrow.id).status, status);
    }
});

test('pending, disputed, completed, cancelled and refunded deals are never selected for active hiding', async () => {
    for (const status of ['pending', 'disputed', 'completed', 'cancelled', 'refunded']) {
        const f = fixture({ status });
        assert.equal((await run(f)).claimed, 0);
        assert.equal(f.calls.length, 0);
        assert.equal(savedJob(f), undefined);
    }
});

test('new messages and a recent reopening each defer an otherwise idle active conversation', async () => {
    const message = fixture({ activityAge: 60000 });
    assert.equal((await run(message)).deferred, 1);
    assert.equal(archives(message).length, 0);
    assert.ok(savedJob(message).due_at >= message.now + 14 * 60000);
    const reopened = fixture();
    reopened.thread.archiveTimestamp = reopened.now - 60000;
    assert.equal((await run(reopened)).deferred, 1);
    assert.equal(archives(reopened).length, 0);
    assert.ok(savedJob(reopened).due_at >= reopened.now + 14 * 60000);
});

test('recent state updates protect an active conversation before it is claimed', async () => {
    const f = fixture();
    db.prepare('UPDATE escrow_transactions SET updated_at = ? WHERE id = ?').run(new Date(f.now).toISOString(), f.escrow.id);
    assert.equal((await run(f)).claimed, 0);
    assert.equal(f.calls.length, 0);
});

test('already archived active conversations finish bookkeeping without status or evidence mutations', async () => {
    const f = fixture({ archived: true });
    assert.equal((await run(f)).hidden, 0);
    assert.equal(savedJob(f).status, 'archived');
    assert.equal(deals.getEscrowEvents(f.escrow.id).filter(event => event.event_type === 'thread_idle_archived').length, 0);
    assert.equal(f.calls.some(call => ['archive', 'messages'].includes(call[0])), false);
});

test('disabled active cleanup performs no Discord requests', async () => {
    const f = fixture({ policy: 0 });
    assert.equal((await run(f)).claimed, 0);
    assert.equal(f.calls.length, 0);
});

test('staff-locked conversations stay locked and visible without any archive operation', async () => {
    const f = fixture(); f.thread.locked = true;
    assert.equal((await run(f)).deferred, 1);
    assert.equal(f.thread.locked, true);
    assert.equal(archives(f).length, 0);
    assert.equal(savedJob(f).status, 'pending');
});

test('a policy change or dispute during fresh permissions prevents hiding the conversation', async () => {
    for (const change of ['policy', 'status']) {
        const f = fixture();
        let parentFetches = 0;
        const fetch = f.guild.channels.fetch;
        f.guild.channels.fetch = async (...args) => {
            if (args[0] === f.parent.id && ++parentFetches === 2) {
                if (change === 'policy') setActiveThreadIdleMinutes(f.escrow.guild_id, 0);
                else db.prepare("UPDATE escrow_transactions SET status = 'disputed' WHERE id = ?").run(f.escrow.id);
            }
            return fetch(...args);
        };
        await run(f);
        assert.equal(archives(f).length, 0);
        assert.equal(f.thread.archived, false);
    }
});

test('a new message detected during the final refresh defers hiding until its timestamp is checked', async () => {
    const f = fixture();
    let parentFetches = 0;
    const fetch = f.guild.channels.fetch;
    f.guild.channels.fetch = async (...args) => {
        if (args[0] === f.parent.id && ++parentFetches === 2) f.thread.lastMessageId = 'new-message';
        return fetch(...args);
    };
    assert.equal((await run(f)).deferred, 1);
    assert.equal(archives(f).length, 0);
});

test('permissions lost during history lookup block the final archive request', async () => {
    const f = fixture();
    const history = f.thread.messages.fetch;
    f.thread.messages.fetch = async (...args) => {
        f.parent.permissionsFor = () => ({ has: () => false });
        return history(...args);
    };
    assert.equal((await run(f)).failed, 1);
    assert.equal(archives(f).length, 0);
});

test('missing permissions, foreign threads, and public conversations never mutate Discord', async () => {
    for (const options of [{ parentAllowed: false }, { threadAllowed: false }, { type: ChannelType.PublicThread }]) {
        const f = fixture(options);
        assert.ok((await run(f)).failed >= 1);
        assert.equal(archives(f).length, 0);
    }
    const f = fixture(); f.thread.guildId = unique('foreign');
    await run(f);
    assert.equal(archives(f).length, 0);
});

test('unreadable history is retried rather than treated as inactivity', async () => {
    const f = fixture();
    f.thread.messages.fetch = async () => { throw Object.assign(new Error('No history'), { code: 50013 }); };
    assert.equal((await run(f)).failed, 1);
    assert.equal(savedJob(f).status, 'pending');
    assert.equal(savedJob(f).last_error, '50013');
    assert.equal(archives(f).length, 0);
});

test('only a definite deleted-channel error marks the source unavailable', async () => {
    const missing = fixture();
    missing.guild.channels.fetch = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
    assert.equal((await run(missing)).unavailable, 1);
    assert.equal(savedJob(missing).status, 'unavailable');
    const denied = fixture();
    denied.guild.channels.fetch = async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); };
    assert.equal((await run(denied)).failed, 1);
    assert.equal(savedJob(denied).status, 'pending');
});

test('manual deal actions and expired worker leases prevent concurrent hiding', async () => {
    const busy = fixture(); processingDeals.add(String(busy.escrow.id));
    assert.equal((await run(busy)).deferred, 1);
    assert.equal(busy.calls.length, 0);
    assert.equal(processingDeals.has(String(busy.escrow.id)), true);
    const expired = fixture();
    let current = expired.now;
    const fetch = expired.guild.channels.fetch;
    expired.guild.channels.fetch = async (...args) => { current = expired.now + 121000; return fetch(...args); };
    await run(expired, { clock: () => current });
    assert.equal(archives(expired).length, 0);
});

test('a lost archive response recognizes actual success without repeating the mutation', async () => {
    const f = fixture();
    f.thread.setArchived = async value => {
        f.calls.push(['archive', value]); f.thread.archived = true; f.thread.archiveTimestamp = Date.now();
        throw Object.assign(new Error('Lost response'), { code: 'ETIMEDOUT' });
    };
    assert.equal((await run(f)).hidden, 1);
    assert.equal(archives(f).length, 1);
    assert.equal(savedJob(f).status, 'archived');
});

test('a failed archive remains retryable without inventing success', async () => {
    const f = fixture();
    f.thread.setArchived = async () => { throw Object.assign(new Error('Denied'), { code: 50013 }); };
    assert.equal((await run(f)).failed, 1);
    assert.equal(savedJob(f).status, 'pending');
    assert.equal(f.thread.archived, false);
});

test('multiple users and trades are processed in bounded batches of five without combining private conversations', async () => {
    const fixtures = Array.from({ length: 7 }, () => fixture());
    const client = { user: fixtures[0].client.user,
        guilds: { fetch: async id => fixtures.find(f => f.guild.id === id)?.guild } };
    assert.equal((await processActiveThreadOrganization(client)).hidden, 5);
    assert.equal((await processActiveThreadOrganization(client)).hidden, 2);
    for (const f of fixtures) {
        assert.equal(archives(f).length, 1);
        assert.equal(savedJob(f).status, 'archived');
        assert.equal(deals.getEscrowById(f.escrow.id).channel_id, f.thread.id);
    }
    assert.equal((await processActiveThreadOrganization(client)).claimed, 0);
});

test('importing active organization creates no timer or Discord session', () => {
    const result = spawnSync(process.execPath, ['-e', `
        global.setInterval=()=>{throw new Error('Import started a timer');};
        const {Client}=require('discord.js');
        Client.prototype.login=()=>{throw new Error('Import logged into Discord');};
        require('./src/services/activeThreadOrganization');
        require('./src/database/init').db.close();
    `], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: ':memory:' },
        encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
});

test('stopping active organization drains the current pass, stops mutation decisions, and prevents overlaps', async () => {
    let tick, resolve, observedStop;
    let calls = 0;
    const gate = new Promise(done => { resolve = done; });
    const stop = startActiveThreadOrganization({ client: {},
        schedule: callback => { tick = callback; return { unref() {} }; }, cancel: () => {},
        processQueue: async (_client, options) => { calls++; await gate; observedStop = options.shouldStop(); },
    });
    await Promise.resolve(); tick(); tick();
    assert.equal(calls, 1);
    const done = stop(); assert.equal(stop(), done);
    let drained = false; done.then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    resolve(); await done; tick();
    assert.equal(calls, 1); assert.equal(observedStop, true);
});
