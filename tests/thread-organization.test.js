process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ChannelType } = require('discord.js');
const { db } = require('../src/database/init');
const deals = require('../src/database/escrowRepository');
const { getOrCreateUser } = require('../src/database/userRepository');
const { setThreadCleanupMinutes } = require('../src/database/guildSettingsRepository');
const { processingDeals } = require('../src/utils/dealLocks');
const { dealThreadName } = require('../src/utils/threadPresentation');
const { processThreadOrganization, startThreadOrganization } = require('../src/services/threadOrganization');

let sequence = 0;
const unique = label => `${label}-${++sequence}`;
beforeEach(() => db.exec('SAVEPOINT worker_test'));
afterEach(() => { processingDeals.clear(); db.exec('ROLLBACK TO worker_test; RELEASE worker_test'); });
after(() => db.close());

function fixture({ status = 'completed', activityAge = 3600000, archived = false, policy,
    parentAllowed = true, threadAllowed = true, type = ChannelType.PrivateThread } = {}) {
    const now = Date.now();
    const guildId = unique('worker-guild');
    const buyer = getOrCreateUser({ id: unique('buyer'), tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: unique('seller'), tag: 'Seller', createdAt: new Date('2020-01-01') });
    let escrow = deals.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Menace Cape', amount: 2, currency: 'USD' });
    if (status !== 'pending') deals.acceptEscrow(escrow.id, unique('worker-thread'), seller.discord_id);
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
    if (policy != null) setThreadCleanupMinutes(guildId, policy);
    const calls = [];
    const bot = { id: 'worker-bot', bot: true };
    const guild = { id: guildId };
    const botMember = { id: bot.id, guild };
    const parent = { id: unique('hub'), guildId, type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => parentAllowed }) };
    const thread = { id: escrow.channel_id, guildId, parentId: parent.id, type, archived, locked: false,
        archiveTimestamp: now - 3600000,
        permissionsFor: () => ({ has: () => threadAllowed }),
        messages: { fetch: async options => {
            calls.push(['messages', options]);
            return new Map([['latest', { createdTimestamp: now - activityAge }]]);
        } },
        setLocked: async value => { calls.push(['lock', value]); thread.locked = value; return thread; },
        setArchived: async value => {
            calls.push(['archive', value]); thread.archived = value; thread.archiveTimestamp = Date.now(); return thread;
        },
        fetch: async () => thread,
    };
    guild.channels = { fetch: async (id, options) => {
        calls.push(['fetch', id, options]);
        return id === parent.id ? parent : id === thread.id ? thread : null;
    } };
    guild.members = { fetchMe: async () => botMember };
    const client = { user: bot, guilds: { fetch: async id => id === guild.id ? guild : null },
        emit: (...args) => { calls.push(['emit', ...args]); } };
    thread.client = client;
    return { now, guild, client, thread, parent, calls, escrow, buyer, seller };
}

function run(f, options) { return processThreadOrganization(f.client, { onError: () => {}, ...options }); }
function savedJob(f) { return db.prepare('SELECT * FROM deal_thread_cleanup WHERE escrow_id = ?').get(f.escrow.id); }
function archivedCalls(f) { return f.calls.filter(call => call[0] === 'archive'); }

test('an idle completed conversation is locked and archived once with durable bot attribution and a queued transcript', async () => {
    const f = fixture();
    const stats = await run(f);
    assert.equal(stats.archived, 1);
    assert.deepEqual(f.calls.filter(call => call[0] === 'lock').map(call => call[1]), [true]);
    assert.deepEqual(archivedCalls(f).map(call => call[1]), [true]);
    assert.equal(savedJob(f).status, 'archived');
    assert.equal(deals.getEscrowById(f.escrow.id).status, 'completed');
    const closure = db.prepare('SELECT * FROM escrow_thread_closures WHERE escrow_id = ?').get(f.escrow.id);
    assert.equal(closure.actor_discord_id, f.client.user.id);
    assert.equal(closure.actor_name, 'DealBot (automatic cleanup)');
    assert.equal(closure.kind, 'untracked');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcript_delivery_archives WHERE escrow_id = ?').get(f.escrow.id).n, 1);
    assert.equal(deals.getEscrowEvents(f.escrow.id).filter(event => event.event_type === 'thread_auto_archived').length, 1);
    const again = await run(f);
    assert.equal(again.claimed, 0);
    assert.equal(archivedCalls(f).length, 1);
});

test('cancelled and refunded conversations can be organized without altering their terminal status', async () => {
    for (const status of ['cancelled', 'refunded']) {
        const f = fixture({ status });
        assert.equal((await run(f)).archived, 1);
        assert.equal(deals.getEscrowById(f.escrow.id).status, status);
    }
});

test('pending, active, and disputed deals never enter automatic cleanup', async () => {
    for (const status of ['pending', 'awaiting_payment', 'funded', 'delivered', 'disputed']) {
        const f = fixture({ status });
        assert.equal((await run(f)).claimed, 0);
        assert.equal(f.calls.length, 0);
        assert.equal(savedJob(f), undefined);
    }
});

test('recent conversation messages defer cleanup until their actual quiet window ends', async () => {
    const f = fixture({ activityAge: 60000 });
    const result = await run(f);
    assert.equal(result.deferred, 1);
    assert.equal(archivedCalls(f).length, 0);
    assert.equal(f.calls.some(call => call[0] === 'lock'), false);
    assert.ok(savedJob(f).due_at >= f.now + 29 * 60000);
    assert.equal(savedJob(f).lease_token, null);
});

test('a recent manual reopen protects a finished conversation even when its latest message is old', async () => {
    const f = fixture();
    f.thread.archiveTimestamp = f.now - 60000;
    assert.equal((await run(f)).deferred, 1);
    assert.equal(archivedCalls(f).length, 0);
    assert.ok(savedJob(f).due_at >= f.now + 29 * 60000);
});

test('a finished conversation updated recently is not claimed prematurely', async () => {
    const f = fixture();
    db.prepare('UPDATE escrow_transactions SET updated_at = ? WHERE id = ?').run(new Date(f.now).toISOString(), f.escrow.id);
    assert.equal((await run(f)).claimed, 0);
    assert.equal(f.calls.length, 0);
});

test('existing archived conversations finish bookkeeping without a new closure, transcript, event, or archive request', async () => {
    const f = fixture({ archived: true });
    assert.equal((await run(f)).archived, 0);
    assert.equal(savedJob(f).status, 'archived');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escrow_thread_closures WHERE escrow_id = ?').get(f.escrow.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcript_delivery_archives WHERE escrow_id = ?').get(f.escrow.id).n, 0);
    assert.equal(f.calls.some(call => ['lock', 'archive', 'messages', 'emit'].includes(call[0])), false);
});

test('disabled cleanup never fetches conversations', async () => {
    const f = fixture({ policy: 0 });
    assert.equal((await run(f)).claimed, 0);
    assert.equal(f.calls.length, 0);
});

test('a policy change while Discord locks the thread cancels archiving and restores its previous unlocked state', async () => {
    const f = fixture();
    const lock = f.thread.setLocked;
    f.thread.setLocked = async value => {
        await lock(value);
        if (value) setThreadCleanupMinutes(f.escrow.guild_id, 0);
        return f.thread;
    };
    await run(f);
    assert.equal(archivedCalls(f).length, 0);
    assert.equal(f.thread.locked, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escrow_thread_closures WHERE escrow_id = ?').get(f.escrow.id).n, 0);
});

test('new activity arriving while locking defers the job and restores its unlocked state', async () => {
    const f = fixture();
    const lock = f.thread.setLocked;
    f.thread.setLocked = async value => {
        await lock(value);
        if (value) f.thread.messages.fetch = async () => new Map([['new', { createdTimestamp: Date.now() }]]);
        return f.thread;
    };
    assert.equal((await run(f)).deferred, 1);
    assert.equal(archivedCalls(f).length, 0);
    assert.equal(f.thread.locked, false);
});

test('a state change to disputed during the lock request prevents automatic archive', async () => {
    const f = fixture();
    const lock = f.thread.setLocked;
    f.thread.setLocked = async value => {
        await lock(value);
        if (value) db.prepare("UPDATE escrow_transactions SET status = 'disputed' WHERE id = ?").run(f.escrow.id);
        return f.thread;
    };
    await run(f);
    assert.equal(archivedCalls(f).length, 0);
    assert.equal(f.thread.locked, false);
});

test('lost parent permissions after locking prevent archive', async () => {
    const f = fixture();
    const lock = f.thread.setLocked;
    f.thread.setLocked = async value => {
        await lock(value);
        if (value) f.parent.permissionsFor = () => ({ has: () => false });
        return f.thread;
    };
    assert.equal((await run(f)).failed, 1);
    assert.equal(archivedCalls(f).length, 0);
    assert.equal(f.thread.locked, false);
});

test('missing permissions, public threads, or cross-server thread responses never mutate Discord', async () => {
    for (const options of [{ parentAllowed: false }, { threadAllowed: false }, { type: ChannelType.PublicThread }]) {
        const f = fixture(options);
        assert.ok((await run(f)).failed >= 1);
        assert.equal(f.calls.some(call => ['lock', 'archive'].includes(call[0])), false);
    }
    const f = fixture();
    f.thread.guildId = unique('other-guild');
    await run(f);
    assert.equal(f.calls.some(call => ['lock', 'archive'].includes(call[0])), false);
});

test('an inaccessible history is retried durably without treating unknown activity as inactivity', async () => {
    const f = fixture();
    f.thread.messages.fetch = async () => { throw Object.assign(new Error('No history'), { code: 50013 }); };
    assert.equal((await run(f)).failed, 1);
    assert.equal(savedJob(f).status, 'pending');
    assert.equal(savedJob(f).last_error, '50013');
    assert.equal(archivedCalls(f).length, 0);
    assert.ok(savedJob(f).due_at > f.now);
});

test('a deleted thread is marked unavailable without inventing a closure or transcript', async () => {
    const f = fixture();
    f.guild.channels.fetch = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
    assert.equal((await run(f)).unavailable, 1);
    assert.equal(savedJob(f).status, 'unavailable');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escrow_thread_closures WHERE escrow_id = ?').get(f.escrow.id).n, 0);
});

test('manual deal controls and background cleanup share the same per-deal lock', async () => {
    const f = fixture();
    processingDeals.add(String(f.escrow.id));
    assert.equal((await run(f)).deferred, 1);
    assert.equal(f.calls.length, 0);
    assert.ok(processingDeals.has(String(f.escrow.id)));
});

test('expired cleanup claims cannot archive a conversation', async () => {
    const f = fixture();
    let current = f.now;
    const fetch = f.guild.channels.fetch;
    f.guild.channels.fetch = async (...args) => {
        const result = await fetch(...args);
        current = f.now + 121000;
        return result;
    };
    await run(f, { clock: () => current });
    assert.equal(archivedCalls(f).length, 0);
    assert.equal(f.thread.locked, false);
});

test('a terminal row updated while message history is loading starts a fresh quiet window', async () => {
    const f = fixture();
    const fetch = f.thread.messages.fetch;
    f.thread.messages.fetch = async options => {
        const result = await fetch(options);
        db.prepare('UPDATE escrow_transactions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), f.escrow.id);
        return result;
    };
    assert.equal((await run(f)).deferred, 1);
    assert.equal(archivedCalls(f).length, 0);
    assert.equal(f.thread.locked, false);
    assert.ok(savedJob(f).due_at >= f.now + 30 * 60000);
});

test('several simultaneous finished deals are organized in bounded batches without mixing conversations', async () => {
    const fixtures = Array.from({ length: 7 }, () => fixture());
    const client = { ...fixtures[0].client,
        guilds: { fetch: async id => fixtures.find(f => f.guild.id === id)?.guild } };
    const first = await processThreadOrganization(client, { onError: () => {} });
    assert.equal(first.claimed, 5);
    assert.equal(first.archived, 5);
    assert.equal(fixtures.reduce((sum, f) => sum + archivedCalls(f).length, 0), 5);
    const second = await processThreadOrganization(client, { onError: () => {} });
    assert.equal(second.claimed, 2);
    assert.equal(second.archived, 2);
    for (const f of fixtures) {
        assert.equal(archivedCalls(f).length, 1);
        assert.equal(savedJob(f).status, 'archived');
        assert.equal(deals.getEscrowById(f.escrow.id).channel_id, f.thread.id);
    }
    assert.equal((await processThreadOrganization(client)).claimed, 0);
});

test('importing organization code creates no timer or Discord session', () => {
    const result = spawnSync(process.execPath, ['-e', `
        global.setInterval=()=>{throw new Error('Import started a timer');};
        const {Client}=require('discord.js');
        Client.prototype.login=()=>{throw new Error('Import logged into Discord');};
        require('./src/services/threadOrganization');
        require('./src/utils/threadPresentation');
        require('./src/database/init').db.close();
    `], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: ':memory:' },
        encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
});

test('compact conversation names preserve the numeric deal reference and omit user names and mention identifiers', () => {
    assert.equal(dealThreadName({ id: 42, item_description: '**Menace Cape**\nMore details', buyer_username: 'Buyer', seller_username: 'Seller' }), 'deal-0042-menace-cape');
    assert.equal(dealThreadName({ id: 321, item_description: '<:Cape:1412345678901234567> <@123456789012345678> # Cape' }), 'deal-0321-cape');
    assert.equal(dealThreadName({ id: 1, item_description: '🎮' }), 'deal-0001-item');
    assert.ok(dealThreadName({ id: 100000, item_description: 'x'.repeat(300) }).length <= 100);
});

test('organization scheduling is serial and stopping waits for active work while preventing further ticks', async () => {
    let tick;
    let resolve;
    let calls = 0;
    let cancelled = 0;
    let observedStop;
    const gate = new Promise(done => { resolve = done; });
    const stop = startThreadOrganization({ client: {},
        schedule: callback => { tick = callback; return { unref() {} }; }, cancel: () => { cancelled++; },
        processQueue: async (_client, options) => { calls++; await gate; observedStop = options.shouldStop(); },
    });
    await Promise.resolve();
    tick(); tick();
    assert.equal(calls, 1);
    const done = stop();
    assert.equal(stop(), done);
    let drained = false;
    done.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    resolve();
    await done;
    tick();
    assert.equal(calls, 1);
    assert.equal(observedStop, true);
    assert.equal(cancelled, 1);
});
