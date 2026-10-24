process.env.DATABASE_PATH = ':memory:';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AttachmentBuilder, Client, ChannelType, Message, Collection } = require('discord.js');
const discordTranscripts = require('discord-html-transcripts');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const escrows = require('../src/database/escrowRepository');
const closures = require('../src/database/transcriptRepository');
const { closeDealThread } = require('../src/utils/threadClosure');
const { buildTranscriptSummary, transcriptFilename, TRANSCRIPT_COLOR } = require('../src/utils/transcriptPresentation');
const { createTranscriptService, TRANSCRIPT_LIMIT } = require('../src/services/transcripts');

const buyerId = '100000000000000001';
const sellerId = '100000000000000002';
const guildId = '200000000000000001';
const channelId = '300000000000000001';
const timestamp = Date.UTC(2026, 9, 24, 12, 30, 15);
const icon = 'https://cdn.discordapp.com/icons/200000000000000001/example.png';
const botAvatar = 'https://cdn.discordapp.com/avatars/100000000000000003/example.png';
const closerAvatar = 'https://cdn.discordapp.com/avatars/100000000000000001/example.png';
const silentLogger = { error() {}, warn() {} };
function escrow(overrides = {}) {
    return {
        id: 7, transaction_uuid: 'ESC-TEST-REFERENCE', guild_id: guildId, channel_id: channelId,
        item_description: 'Menace Cape', status: 'completed', amount: 20, currency: 'Redblocks', payment_unit: 'stacks',
        buyer_discord_id: buyerId, buyer_username: 'Buyer', seller_discord_id: sellerId, seller_username: 'Seller',
        ...overrides,
    };
}
function closure(overrides = {}) {
    return { id: 1, escrow_id: 7, actor_discord_id: buyerId, actor_name: 'Buyer', kind: 'participant',
        status: 'archived', archive_timestamp: timestamp, ...overrides };
}
function summary(overrides = {}) {
    return buildTranscriptSummary({ escrow: escrow(), closure: closure(),
        guild: { name: 'Market', iconURL: () => icon },
        clientUser: { displayAvatarURL: () => botAvatar }, closerUser: { displayAvatarURL: () => closerAvatar },
        ...overrides });
}
const field = (embed, name) => embed.fields.find(entry => entry.name === name)?.value;
function serviceFixture(overrides = {}) {
    const stored = escrow();
    const sent = new Map([[buyerId, []], [sellerId, []]]);
    const calls = { generated: [], recorded: [], errors: [], warnings: [] };
    const attachment = new AttachmentBuilder(Buffer.from('<html>Complete conversation</html>'), { name: 'transcript.html' });
    const client = {
        user: { displayAvatarURL: () => botAvatar },
        users: {
            cache: new Map([[buyerId, { displayAvatarURL: () => closerAvatar }]]),
            fetch: async id => ({ send: async payload => { sent.get(id).push(payload); } }),
        },
    };
    const thread = {
        id: channelId, guildId, archived: true, archiveTimestamp: timestamp,
        guild: { name: 'Market', iconURL: () => icon }, client,
    };
    const service = createTranscriptService({
        createTranscript: async (channel, options) => { calls.generated.push({ channel, options }); return attachment; },
        findEscrow: () => stored,
        recordArchive: (id, archiveTimestamp) => {
            calls.recorded.push({ id, archiveTimestamp });
            return closure({ archive_timestamp: archiveTimestamp });
        },
        logger: {
            error: (...args) => calls.errors.push(args), warn: (...args) => calls.warnings.push(args),
        },
        ...overrides,
    });
    return { stored, sent, calls, attachment, thread, service };
}

test('transcript summary renders the purple card with exact close identity/time and payment details', () => {
    const payload = summary();
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.color, TRANSCRIPT_COLOR);
    assert.equal(embed.color, 0x8B5CF6);
    assert.equal(embed.author.name, 'Market');
    assert.equal(embed.author.icon_url, icon);
    assert.equal(embed.thumbnail.url, icon);
    assert.match(embed.title, /Deal Transcript.*Menace Cape/);
    for (const name of ['Created By', 'Seller', 'Payment', 'Closed By', 'Closed At']) assert.ok(field(embed, name), name);
    assert.match(field(embed, 'Created By'), new RegExp(`Buyer : ${buyerId}`));
    assert.match(field(embed, 'Seller'), new RegExp(`Seller : ${sellerId}`));
    assert.match(field(embed, 'Payment'), /20 stacks of Redblocks \(1,280 blocks\)/);
    assert.match(field(embed, 'Closed By'), new RegExp(`Buyer : ${buyerId}`));
    assert.equal(field(embed, 'Closed At'), `<t:${Math.floor(timestamp / 1000)}:F>`);
    assert.equal(embed.timestamp, new Date(timestamp).toISOString());
    assert.equal(embed.footer.text, 'Buyer • Completed');
    assert.equal(embed.footer.icon_url, closerAvatar);
    assert.equal(payload.components[0].toJSON().components[0].url, `https://discord.com/channels/${guildId}/${channelId}`);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('user-written code fences cannot escape the transcript detail cards', () => {
    const payload = summary({
        escrow: escrow({ item_description: 'Cape ```\n@everyone\n```', buyer_username: 'Buyer ```injected```' }),
        closure: closure({ actor_name: 'Closer ```injected```' }),
    });
    const embed = payload.embeds[0].toJSON();
    for (const name of ['Deal', 'Created By', 'Closed By']) {
        const value = field(embed, name);
        assert.equal((value.match(/```/g) || []).length, 2, name);
        assert.ok(value.startsWith('```\n'));
        assert.ok(value.endsWith('\n```'));
        assert.ok(value.includes('ˋˋˋ'), name);
        assert.ok(value.length <= 1024);
    }
    assert.deepEqual(payload.allowedMentions.parse, []);
    const filename = transcriptFilename(escrow({ item_description: '../../private/<script>\nCape' }));
    assert.match(filename, /^transcript-[a-z0-9-]+-7\.html$/);
    assert.ok(!filename.includes('/'));
});

test('transcript payments distinguish stack totals, individual game amounts, money, and legacy records', () => {
    const examples = [
        [{ amount: 20, currency: 'Golds', payment_unit: 'stacks' }, '20 stacks of Golds (1,280 items)'],
        [{ amount: 20, currency: 'Sky 1 Notchs', payment_unit: 'each' }, '20 Sky 1 Notchs'],
        [{ amount: 12.5, currency: 'USD', payment_unit: 'each' }, 'Money · $12.50'],
        [{ amount: 2.5, currency: 'old coins', payment_unit: null }, '2.5 old coins'],
    ];
    for (const [payment, expected] of examples) {
        const embed = summary({ escrow: escrow(payment) }).embeds[0].toJSON();
        assert.equal(field(embed, 'Payment'), `\`\`\`\n${expected}\n\`\`\``);
    }
});

test('unknown external closures remain truthful and missing guild icons fall back to the bot avatar', () => {
    const payload = summary({ closure: closure({ actor_discord_id: null, actor_name: null, kind: 'untracked' }),
        guild: { name: 'Market', iconURL: () => null }, closerUser: null });
    const embed = payload.embeds[0].toJSON();
    assert.match(field(embed, 'Closed By'), /Automatic archive or a Discord-side action/);
    assert.ok(!field(embed, 'Closed By').includes(buyerId));
    assert.equal(embed.footer.text, 'DealBot • Completed');
    assert.equal(embed.footer.icon_url, undefined);
    assert.equal(embed.author.icon_url, botAvatar);
    assert.equal(embed.thumbnail.url, botAvatar);
});

test('transcript service sends the styled summary and the same HTML attachment to both participants', async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.deliver(fixture.thread);
    assert.deepEqual(result.delivered, [buyerId, sellerId]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.hasTranscript, true);
    assert.equal(fixture.calls.generated.length, 1);
    const options = fixture.calls.generated[0].options;
    assert.equal(options.limit, TRANSCRIPT_LIMIT);
    assert.equal(options.returnType, 'attachment');
    assert.equal(options.saveImages, false);
    assert.equal(options.poweredBy, false);
    assert.match(options.filename, /^transcript-menace-cape-7\.html$/);
    for (const userId of [buyerId, sellerId]) {
        const [payload] = fixture.sent.get(userId);
        assert.equal(payload.files[0], fixture.attachment);
        assert.equal(payload.embeds[0].toJSON().color, TRANSCRIPT_COLOR);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
    }
});

test('one participant with closed DMs does not prevent delivery to the other', async () => {
    const fixture = serviceFixture();
    fixture.thread.client.users.fetch = async userId => {
        if (userId === buyerId) throw new Error('DMs unavailable');
        return { send: async payload => fixture.sent.get(userId).push(payload) };
    };
    const result = await fixture.service.deliver(fixture.thread);
    assert.deepEqual(result.failed, [buyerId]);
    assert.deepEqual(result.delivered, [sellerId]);
    assert.equal(fixture.sent.get(sellerId).length, 1);
    assert.equal(fixture.calls.warnings.length, 1);
});

test('HTML generation failure still delivers an honest summary without a fabricated attachment', async () => {
    const fixture = serviceFixture({ createTranscript: async () => { throw new Error('Transcript generation failed'); } });
    const result = await fixture.service.deliver(fixture.thread);
    assert.equal(result.hasTranscript, false);
    assert.deepEqual(result.delivered, [buyerId, sellerId]);
    for (const userId of [buyerId, sellerId]) {
        const [payload] = fixture.sent.get(userId);
        assert.deepEqual(payload.files, []);
        assert.match(field(payload.embeds[0].toJSON(), 'Transcript'), /could not be generated/);
    }
    assert.equal(fixture.calls.errors.length, 1);
});

test('concurrent REST and Gateway archive observations deliver once, while a later archive is distinct', async () => {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let generations = 0;
    const attachment = new AttachmentBuilder(Buffer.from('<html>Conversation</html>'), { name: 'transcript.html' });
    const fixture = serviceFixture({ createTranscript: async () => { generations++; await blocked; return attachment; } });
    const rest = fixture.service.deliver(fixture.thread, timestamp);
    const gateway = fixture.service.deliver(fixture.thread, timestamp);
    release();
    const results = await Promise.all([rest, gateway]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(generations, 1);
    assert.equal(fixture.sent.get(buyerId).length, 1);
    assert.deepEqual(await fixture.service.deliver(fixture.thread, timestamp), { skipped: true });
    await fixture.service.deliver(fixture.thread, timestamp + 60000);
    assert.equal(generations, 2);
    assert.equal(fixture.sent.get(buyerId).length, 2);
    assert.equal(fixture.sent.get(sellerId).length, 2);
});

test('non-deal channels, mismatched servers, active threads, and absent archive timestamps send nothing', async () => {
    const cases = [
        serviceFixture({ findEscrow: () => undefined }),
        serviceFixture({ findEscrow: () => escrow({ guild_id: 'other-server' }) }),
        serviceFixture(), serviceFixture(),
    ];
    cases[2].thread.archived = false;
    cases[3].thread.archiveTimestamp = null;
    for (const fixture of cases) {
        assert.deepEqual(await fixture.service.deliver(fixture.thread), { skipped: true });
        assert.equal(fixture.calls.generated.length, 0);
        assert.equal(fixture.calls.recorded.length, 0);
        assert.equal(fixture.sent.get(buyerId).length, 0);
        assert.equal(fixture.sent.get(sellerId).length, 0);
    }
});

test('failure to persist archive metadata releases the service lock and allows a successful retry', async () => {
    let attempts = 0;
    const fixture = serviceFixture({ recordArchive: (id, archiveTimestamp) => {
        attempts++;
        if (attempts === 1) throw new Error('Temporary database failure');
        return closure({ escrow_id: id, archive_timestamp: archiveTimestamp });
    } });
    await assert.rejects(fixture.service.deliver(fixture.thread), /Temporary database failure/);
    assert.equal(fixture.calls.generated.length, 0);
    assert.equal(fixture.sent.get(buyerId).length, 0);
    const retry = await fixture.service.deliver(fixture.thread);
    assert.equal(attempts, 2);
    assert.deepEqual(retry.delivered, [buyerId, sellerId]);
    assert.equal(fixture.calls.generated.length, 1);
});

function realDiscordObjects() {
    const client = new Client({ intents: [] });
    const guild = client.guilds._add({ id: guildId, name: 'Market', icon: null, features: [], roles: [] });
    const channel = client.channels._add({ id: channelId, guild_id: guild.id,
        name: 'deal-menace-cape', type: ChannelType.GuildText }, guild);
    const message = new Message(client, {
        id: '400000000000000001', channel_id: channel.id, guild_id: guild.id,
        author: { id: buyerId, username: 'buyer', discriminator: '0', avatar: null },
        content: 'Paid 20 stacks of Redblocks for the Menace Cape.', timestamp: new Date().toISOString(),
        type: 0, tts: false, mention_everyone: false, mentions: [], mention_roles: [],
        attachments: [], embeds: [], flags: 0, components: [], pinned: false,
    });
    return { client, guild, channel, message };
}

test('the installed HTML transcript library renders real offline Discord SDK messages', async () => {
    const { client, channel, message } = realDiscordObjects();
    try {
        const html = await discordTranscripts.generateFromMessages([message], channel, {
            returnType: 'string', saveImages: false, poweredBy: false,
        });
        assert.equal(typeof html, 'string');
        assert.match(html, /Paid 20 stacks of Redblocks for the Menace Cape/);
        assert.match(html, /deal-menace-cape/);
        assert.match(html, /buyer/);
    } finally { client.destroy(); }
});

test('real createTranscript and the service produce an HTML attachment from fetched SDK messages without network', async () => {
    const { client, channel, message } = realDiscordObjects();
    const deliveries = new Map([[buyerId, []], [sellerId, []]]);
    let fetches = 0;
    channel.messages.fetch = async () => { fetches++; return new Collection([[message.id, message]]); };
    channel.archived = true;
    channel.archiveTimestamp = timestamp;
    client.users.fetch = async userId => ({ send: async payload => deliveries.get(userId).push(payload) });
    const service = createTranscriptService({
        createTranscript: discordTranscripts.createTranscript,
        findEscrow: () => escrow(), recordArchive: () => closure(), logger: silentLogger,
    });
    try {
        const result = await service.deliver(channel);
        assert.equal(result.hasTranscript, true);
        assert.equal(fetches, 1);
        assert.deepEqual(result.delivered, [buyerId, sellerId]);
        for (const userId of [buyerId, sellerId]) {
            const [payload] = deliveries.get(userId);
            const attachment = payload.files[0];
            assert.match(attachment.name, /^transcript-menace-cape-7\.html$/);
            assert.ok(Buffer.isBuffer(attachment.attachment));
            assert.match(attachment.attachment.toString(), /Paid 20 stacks of Redblocks for the Menace Cape/);
        }
    } finally { client.destroy(); }
});

test('a real persisted close request survives the API/Gateway race and produces one correctly attributed DM per participant', async () => {
    const buyer = getOrCreateUser({ id: buyerId, tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: sellerId, tag: 'Seller', createdAt: new Date('2020-01-01') });
    const stored = escrows.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id,
        itemDescription: 'Menace Cape', amount: 20, currency: 'Redblocks', paymentUnit: 'stacks' });
    escrows.acceptEscrow(stored.id, channelId, sellerId);
    escrows.markAsFunded(stored.id, buyerId);
    escrows.markAsDelivered(stored.id, sellerId);
    escrows.completeEscrow(stored.id, buyer.id, seller.id, buyerId);
    const deliveries = new Map([[buyerId, []], [sellerId, []]]);
    const observed = [];
    const client = new EventEmitter();
    client.user = { displayAvatarURL: () => botAvatar };
    client.users = { cache: new Map(), fetch: async userId => ({ send: async payload => deliveries.get(userId).push(payload) }) };
    const service = createTranscriptService({
        createTranscript: async () => new AttachmentBuilder(Buffer.from('<html>Conversation</html>'), { name: 'transcript.html' }),
        logger: silentLogger,
    });
    const channel = {
        id: channelId, guildId, archived: false, archiveTimestamp: null, client,
        guild: { name: 'Market', iconURL: () => icon }, setLocked: async () => {},
        setArchived: async function () {
            this.archived = true;
            this.archiveTimestamp = Date.now();
            observed.push(service.deliver(this, this.archiveTimestamp)); // Gateway observation arrives first.
            return this;
        },
    };
    client.on('dealThreadArchived', (thread, archiveTimestamp) => observed.push(service.deliver(thread, archiveTimestamp)));
    const result = await closeDealThread({ channel, escrowId: stored.id,
        actor: { id: buyerId, tag: 'Buyer' }, kind: 'participant', reason: 'Both participants approved' });
    await Promise.all(observed);
    assert.equal(result.archived, true);
    assert.equal(result.metadataPending, false);
    const persisted = closures.getThreadClosure(stored.id, channel.archiveTimestamp);
    assert.equal(persisted.actor_discord_id, buyerId);
    assert.equal(persisted.status, 'archived');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM escrow_thread_closures WHERE escrow_id = ?').get(stored.id).n, 1);
    for (const userId of [buyerId, sellerId]) {
        assert.equal(deliveries.get(userId).length, 1);
        assert.match(field(deliveries.get(userId)[0].embeds[0].toJSON(), 'Closed By'), new RegExp(buyerId));
    }
});

after(() => db.close());
