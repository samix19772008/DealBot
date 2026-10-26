process.env.DATABASE_PATH = ':memory:';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { getGuildReputation } = require('../src/database/reputationRepository');
const { startOfferMaintenance } = require('../src/services/offerMaintenance');
const { setHubChannel } = require('../src/database/guildSettingsRepository');
const repo = require('../src/database/escrowRepository');
const router = require('../src/events/interactionCreate');
const { sendDealOffer, REQUIRED_HUB_PERMISSIONS } = require('../src/utils/dealOffer');
const { parseAmount, parsePrice, validateDealInput, MAX_AMOUNT } = require('../src/utils/validation');
const { normalizeLocale, resolveGuildLocale, t, SUPPORTED_LOCALES } = require('../src/utils/i18n');

let sequence = 0;
const id = () => String(600000000000000000n + BigInt(++sequence));
function discordUser(name = 'Trader') {
    return { id: id(), tag: `${name}${sequence}`, bot: false, createdAt: new Date('2020-01-01') };
}
function seedDeal(guildId = 'guild', buyer = discordUser('Buyer'), seller = discordUser('Seller')) {
    return repo.createEscrow({ guildId, buyerId: getOrCreateUser(buyer).id, sellerId: getOrCreateUser(seller).id,
        itemDescription: 'Digital item', amount: 25.5, currency: 'USD' });
}
function routedInteraction(overrides = {}) {
    const calls = [];
    return {
        guildId: 'guild', channelId: 'thread', user: discordUser(), customId: 'unknown',
        replied: false, deferred: false, calls,
        isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
        isButton: () => true, isModalSubmit: () => false,
        reply: async function (payload) { calls.push(payload); this.replied = true; },
        followUp: async payload => { calls.push(payload); },
        ...overrides,
    };
}
function offerFixture() {
    const guildId = id();
    const buyer = discordUser('Buyer');
    const seller = discordUser('Seller');
    const sent = { dm: [], hub: [], replies: [], deferrals: [] };
    const botMember = { id: id() };
    const buyerMember = { id: buyer.id };
    const sellerMember = { id: seller.id };
    const hub = {
        id: id(), type: ChannelType.GuildText,
        permissionsFor: () => new PermissionsBitField(REQUIRED_HUB_PERMISSIONS),
        send: async payload => { sent.hub.push(payload); return { url: 'https://discord.com/channels/example/hub/offer' }; },
    };
    seller.send = async payload => { sent.dm.push(payload); };
    const guild = {
        id: guildId, name: 'Escrow Test Server',
        members: {
            fetch: async userId => userId === seller.id ? sellerMember : buyerMember,
            fetchMe: async () => botMember,
        },
        channels: { fetch: async () => hub },
    };
    const interaction = {
        guildId, guild, user: buyer, member: buyerMember, deferred: false, replied: false,
        deferReply: async function (payload) { this.deferred = true; sent.deferrals.push(payload); },
        reply: async function (payload) { this.replied = true; sent.replies.push(payload); },
        editReply: async function (payload) { this.replied = true; sent.replies.push(payload); },
    };
    setHubChannel(guildId, hub.id);
    return { interaction, sellerDiscordUser: seller, itemDescription: 'A digital item', amount: 25.5,
        currency: 'USD', sent, hub, botMember, buyerMember, sellerMember };
}
const allDeals = () => db.prepare('SELECT * FROM escrow_transactions ORDER BY id').all();

beforeEach(() => {
    db.exec('DELETE FROM offer_cooldowns; DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;');
    router.processingDeals.clear();
});
after(() => db.close());

test('amount parsing rejects nonfinite, partial, excessively precise, and out-of-range inputs', () => {
    for (const value of ['Infinity', Infinity, NaN, '25garbage', '25 USD', '1.001', '1e3', '-1', '0', '0.00', '10000000000', '', null]) {
        assert.throws(() => parseAmount(value), undefined, `Accepted unsafe amount ${String(value)}`);
    }
    assert.equal(parseAmount(' 25.50 '), 25.5);
    assert.equal(parseAmount('0.01'), 0.01);
    assert.equal(parseAmount('9999999999.99'), MAX_AMOUNT);
});

test('price parsing preserves the agreed currency and rejects malformed or mention-based prices', () => {
    assert.deepEqual(parsePrice(' 25.50 USD '), { amount: 25.5, currency: 'USD' });
    assert.deepEqual(parsePrice('50 gold coins'), { amount: 50, currency: 'gold coins' });
    for (const value of ['25USD', 'Infinity USD', '25.001 USD', '25', '0 USD', '25 <@123>', '25 @everyone']) {
        assert.throws(() => parsePrice(value), undefined, `Accepted unsafe price ${value}`);
    }
    assert.throws(() => validateDealInput({ itemDescription: 'x'.repeat(1001), amount: 1, currency: 'USD' }));
    assert.throws(() => validateDealInput({ itemDescription: 'Item', amount: 1, currency: 'x'.repeat(25) }));
});

test('legacy Arabic preferences and Discord locales still produce English bot messages', () => {
    assert.deepEqual(SUPPORTED_LOCALES, ['en']);
    assert.equal(normalizeLocale('ar'), 'en');
    assert.equal(normalizeLocale('ar-SA'), 'en');
    assert.equal(resolveGuildLocale({ guildLocale: 'ar', locale: 'ar' }), 'en');
    assert.match(t('deal.newRequest', 'ar'), /New Escrow Request/);
    assert.equal(t('deal.waitingApproval', 'ar', { seller: 'Alice' }), "Waiting for Alice's approval");
    assert.equal(/[\u0600-\u06ff]/u.test(t('errors.hubNotConfigured', 'ar')), false);
});

test('the interaction router rejects actions from a different server or thread before executing handlers', async () => {
    const deal = seedDeal();
    repo.acceptEscrow(deal.id, 'thread');
    let executions = 0;
    const handler = { id: 'confirm_payment_', execute: async () => { executions++; } };
    const client = { buttons: [handler], modals: [], commands: new Map() };
    for (const overrides of [{ guildId: 'wrong-server' }, { channelId: 'wrong-thread' }]) {
        const input = routedInteraction({ customId: `confirm_payment_${deal.id}`, ...overrides });
        await router.execute(input, client);
        assert.equal(input.calls.length, 1);
        assert.equal(input.calls[0].ephemeral, true);
        assert.match(input.calls[0].content, /different server|original deal thread/);
    }
    assert.equal(executions, 0);
    assert.equal(repo.getEscrowById(deal.id).status, 'awaiting_payment');
});

test('only pending offer actions are allowed in DMs, while active deal actions require the original thread', async () => {
    const deal = seedDeal();
    let executions = 0;
    const accept = { id: 'accept_escrow_', execute: async () => { executions++; } };
    const payment = { id: 'confirm_payment_', execute: async () => { executions++; } };
    const client = { buttons: [accept, payment], modals: [], commands: new Map() };
    const pending = routedInteraction({ guildId: null, customId: `accept_escrow_${deal.id}` });
    await router.execute(pending, client);
    assert.equal(executions, 1);
    repo.acceptEscrow(deal.id, 'thread');
    const active = routedInteraction({ guildId: null, customId: `confirm_payment_${deal.id}` });
    await router.execute(active, client);
    assert.equal(executions, 1);
    assert.match(active.calls[0].content, /inside the deal thread/);
});

test('concurrent actions on one deal are rejected and the router lock is released even after a handler throws', async context => {
    context.mock.method(console, 'error', () => {});
    const deal = seedDeal();
    repo.acceptEscrow(deal.id, 'thread');
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    let executions = 0;
    const handler = {
        id: 'confirm_payment_',
        execute: async () => {
            executions++;
            if (executions === 1) { notifyStarted(); await blocked; throw new Error('Simulated handler failure'); }
        },
    };
    const client = { buttons: [handler], modals: [], commands: new Map() };
    const first = routedInteraction({ customId: `confirm_payment_${deal.id}` });
    const pending = router.execute(first, client);
    await started;
    try {
        const second = routedInteraction({ customId: `confirm_payment_${deal.id}` });
        await router.execute(second, client);
        assert.equal(executions, 1);
        assert.match(second.calls[0].content, /Another action is processing/);
    } finally {
        release();
        await pending;
    }
    assert.equal(router.processingDeals.size, 0);
    assert.match(first.calls[0].content, /could not be completed/);
    await router.execute(routedInteraction({ customId: `confirm_payment_${deal.id}` }), client);
    assert.equal(executions, 2);
    assert.equal(router.processingDeals.size, 0);
});

test('unknown buttons and malformed custom IDs receive a private response instead of timing out', async () => {
    let executions = 0;
    const client = { buttons: [{ id: 'confirm_payment_', execute: async () => { executions++; } }], modals: [], commands: new Map() };
    for (const customId of ['removed_action_1', 'confirm_payment_not-an-id']) {
        const input = routedInteraction({ customId });
        await router.execute(input, client);
        assert.equal(input.calls.length, 1);
        assert.equal(input.calls[0].ephemeral, true);
        assert.match(input.calls[0].content, /no longer available|invalid/);
    }
    assert.equal(executions, 0);
});

test('the router enforces administrator-only slash commands and rejects slash commands in DMs', async () => {
    let executions = 0;
    const command = { data: { toJSON: () => ({ default_member_permissions: String(PermissionFlagsBits.Administrator) }) },
        execute: async () => { executions++; } };
    const client = { buttons: [], modals: [], commands: new Map([['setup', command]]) };
    for (const overrides of [{ guildId: null }, { memberPermissions: new PermissionsBitField() }]) {
        const input = routedInteraction({ commandName: 'setup', isChatInputCommand: () => true, ...overrides });
        await router.execute(input, client);
        assert.equal(input.calls.length, 1);
        assert.match(input.calls[0].content, /inside your server|permission/);
    }
    assert.equal(executions, 0);
});

test('a successfully delivered seller DM creates one pending offer with usable controls and an audit entry', async () => {
    const fixture = offerFixture();
    await sendDealOffer(fixture);
    const [deal] = allDeals();
    assert.equal(allDeals().length, 1);
    assert.equal(deal.status, 'pending');
    assert.equal(deal.item_description, 'A digital item');
    assert.equal(fixture.sent.dm.length, 1);
    assert.equal(fixture.sent.hub.length, 0);
    const controls = fixture.sent.dm[0].components[0].toJSON().components;
    assert.ok(controls.some(button => button.custom_id === `accept_escrow_${deal.id}`));
    assert.ok(controls.some(button => button.custom_id === `cancel_escrow_${deal.id}`));
    assert.equal(repo.getEscrowEvents(deal.id)[0].event_type, 'created');
    assert.match(fixture.sent.replies.at(-1).content, /sent.*via DM/);
    assert.equal(fixture.sent.deferrals[0].ephemeral, true);
});

test('explicit public-offer consent allows closed seller DMs to fall back to one hub message', async () => {
    const fixture = offerFixture();
    fixture.allowPublicOffer = true;
    fixture.sellerDiscordUser.send = async () => { throw new Error('DMs closed'); };
    await sendDealOffer(fixture);
    assert.equal(allDeals().length, 1);
    assert.equal(allDeals()[0].status, 'pending');
    assert.equal(fixture.sent.hub.length, 1);
    assert.deepEqual(fixture.sent.hub[0].allowedMentions, { parse: [], users: [fixture.sellerDiscordUser.id] });
    assert.match(fixture.sent.replies.at(-1).content, /posted in the escrow hub/);
});

test('failure to deliver through both DM and hub cancels the offer and records why', async context => {
    context.mock.method(console, 'warn', () => {});
    const fixture = offerFixture();
    fixture.allowPublicOffer = true;
    fixture.sellerDiscordUser.send = async () => { throw new Error('DMs closed'); };
    fixture.hub.send = async () => { throw new Error('Hub write failed'); };
    await sendDealOffer(fixture);
    const [deal] = allDeals();
    assert.equal(deal.status, 'cancelled');
    const event = repo.getEscrowEvents(deal.id)[0];
    assert.equal(event.event_type, 'cancelled');
    assert.equal(event.actor_discord_id, fixture.interaction.user.id);
    assert.match(event.reason, /Offer delivery failed/);
    assert.match(fixture.sent.replies.at(-1).content, /could not be delivered and was cancelled/);
});

test('self deals, bot sellers, and flagged participants are rejected without sending an offer', async () => {
    for (const kind of ['self', 'bot', 'scammer']) {
        const fixture = offerFixture();
        if (kind === 'self') fixture.sellerDiscordUser = fixture.interaction.user;
        if (kind === 'bot') fixture.sellerDiscordUser.bot = true;
        if (kind === 'scammer') {
            const seller = getOrCreateUser(fixture.sellerDiscordUser);
            getGuildReputation(fixture.interaction.guildId, seller.id);
            db.prepare('UPDATE guild_user_profiles SET is_scammer = 1, scam_flag_count = 1 WHERE guild_id = ? AND user_id = ?')
                .run(fixture.interaction.guildId, seller.id);
        }
        await sendDealOffer(fixture);
        assert.equal(allDeals().length, 0, kind);
        assert.equal(fixture.sent.dm.length, 0, kind);
        assert.equal(fixture.sent.hub.length, 0, kind);
        assert.match(fixture.sent.replies.at(-1).content, /yourself|with a bot|flagged as a scammer/);
    }
});

test('ten active deals block additional requests without creating another pending row', async () => {
    const fixture = offerFixture();
    for (let i = 0; i < 10; i++) seedDeal(fixture.interaction.guildId, fixture.interaction.user, fixture.sellerDiscordUser);
    await sendDealOffer(fixture);
    assert.equal(allDeals().length, 10);
    assert.equal(fixture.sent.dm.length, 0);
    assert.match(fixture.sent.replies.at(-1).content, /already have 10 active deals/);
});

test('rapid repeat requests are rate limited without delivering duplicate offers', async () => {
    const fixture = offerFixture();
    await sendDealOffer(fixture);
    await sendDealOffer(fixture);
    assert.equal(allDeals().length, 1);
    assert.equal(fixture.sent.dm.length, 1);
    const match = fixture.sent.replies.at(-1).content.match(/wait (\d+) seconds/);
    assert.ok(match);
    assert.ok(Number(match[1]) > 0 && Number(match[1]) <= 15);
});

test('missing hub permissions and sellers outside the server never create undeliverable pending deals', async () => {
    const noPermissions = offerFixture();
    noPermissions.hub.permissionsFor = () => new PermissionsBitField();
    await sendDealOffer(noPermissions);
    assert.equal(allDeals().length, 0);
    assert.match(noPermissions.sent.replies.at(-1).content, /bot needs/);
    const missingSeller = offerFixture();
    missingSeller.interaction.guild.members.fetch = async () => { throw new Error('Unknown member'); };
    await sendDealOffer(missingSeller);
    assert.equal(allDeals().length, 0);
    assert.match(missingSeller.sent.replies.at(-1).content, /seller must be a member/);
    assert.equal(missingSeller.sent.dm.length, 0);
});

test('legacy global flags and flags in another server do not block a local offer', async () => {
    const fixture = offerFixture();
    const seller = getOrCreateUser(fixture.sellerDiscordUser);
    // Preserve a pre-upgrade flag as fixture evidence without invoking the disabled global mutation API.
    db.prepare('UPDATE users SET is_scammer = 1, scam_flag_count = 1 WHERE id = ?').run(seller.id);
    getGuildReputation('unrelated-server', seller.id);
    db.prepare('UPDATE guild_user_profiles SET is_scammer = 1, scam_flag_count = 1 WHERE guild_id = ? AND user_id = ?')
        .run('unrelated-server', seller.id);
    await sendDealOffer(fixture);
    assert.equal(allDeals().length, 1);
    assert.equal(allDeals()[0].status, 'pending');
    assert.equal(fixture.sent.dm.length, 1);
    assert.equal(getGuildReputation(fixture.interaction.guildId, seller.id).is_scammer, 0);
});

test('cooldown survives reloading the offer module instead of resetting with process memory', async () => {
    const fixture = offerFixture();
    await sendDealOffer(fixture);
    const modulePath = require.resolve('../src/utils/dealOffer');
    delete require.cache[modulePath];
    await require(modulePath).sendDealOffer(fixture);
    assert.equal(allDeals().length, 1);
    assert.equal(fixture.sent.dm.length, 1);
    assert.match(fixture.sent.replies.at(-1).content, /wait \d+ seconds/);
});

test('creating an offer expires only stale unaccepted requests before checking the active limit', async () => {
    const fixture = offerFixture();
    const expired = [];
    for (let i = 0; i < 10; i++) expired.push(seedDeal(fixture.interaction.guildId, fixture.interaction.user, fixture.sellerDiscordUser));
    db.prepare("UPDATE escrow_transactions SET created_at = datetime('now', '-25 hours') WHERE guild_id = ?")
        .run(fixture.interaction.guildId);
    await sendDealOffer(fixture);
    assert.equal(allDeals().length, 11);
    assert.equal(allDeals().filter(row => row.status === 'pending').length, 1);
    for (const old of expired) {
        assert.equal(repo.getEscrowById(old.id).status, 'cancelled');
        assert.equal(repo.getEscrowEvents(old.id)[0].event_type, 'offer_expired');
    }
    assert.equal(fixture.sent.dm.length, 1);
});

test('a concurrent request filling the final slots during Discord lookups cannot exceed the active cap', async () => {
    const fixture = offerFixture();
    fixture.interaction.guild.members.fetchMe = async () => {
        for (let i = 0; i < 10; i++) seedDeal(fixture.interaction.guildId, fixture.interaction.user, fixture.sellerDiscordUser);
        return fixture.botMember;
    };
    await sendDealOffer(fixture);
    assert.equal(allDeals().length, 10);
    assert.equal(fixture.sent.dm.length, 0);
    assert.match(fixture.sent.replies.at(-1).content, /already have 10 active deals/);
});

test('offer maintenance starts explicitly, unreferences its timer, survives expiry errors, and stops cleanly', () => {
    let attempts = 0;
    let callback;
    let cleared = 0;
    let unreferenced = 0;
    const errors = [];
    const timer = { unref: () => { unreferenced++; } };
    const stop = startOfferMaintenance({
        expire: () => { attempts++; if (attempts === 1) throw new Error('Temporary database error'); },
        schedule: (run, interval) => { callback = run; assert.equal(interval, 60_000); return timer; },
        cancel: value => { assert.equal(value, timer); cleared++; },
        onError: error => { errors.push(error.message); },
    });
    assert.equal(attempts, 1);
    assert.equal(unreferenced, 1);
    assert.deepEqual(errors, ['Temporary database error']);
    callback();
    assert.equal(attempts, 2);
    stop();
    stop();
    callback();
    assert.equal(attempts, 2);
    assert.equal(cleared, 1);
});

test('seller DM failure cancels privately by default without exposing item or payment in the hub', async () => {
    const fixture = offerFixture();
    fixture.sellerDiscordUser.send = async () => { throw new Error('DMs closed'); };
    await sendDealOffer(fixture);
    const [deal] = allDeals();
    assert.equal(deal.status, 'cancelled');
    assert.equal(fixture.sent.hub.length, 0);
    const event = repo.getEscrowEvents(deal.id)[0];
    assert.equal(event.event_type, 'cancelled');
    assert.equal(event.actor_discord_id, fixture.interaction.user.id);
    assert.equal(event.reason, 'Seller DMs unavailable; public posting not permitted');
    assert.match(fixture.sent.replies.at(-1).content, /cancelled/);
    assert.match(fixture.sent.replies.at(-1).content, /enable server DMs.*Request a Deal/);
    assert.equal(fixture.sent.deferrals[0].ephemeral, true);
});
