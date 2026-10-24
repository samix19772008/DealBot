process.env.DATABASE_PATH = ':memory:';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField } = require('discord.js');
const { db } = require('../src/database/init');
const { setHubChannel } = require('../src/database/guildSettingsRepository');
const { REQUIRED_HUB_PERMISSIONS } = require('../src/utils/dealOffer');
const create = require('../src/commands/escrow/create');
const deals = require('../src/commands/escrow/deals');
const status = require('../src/commands/escrow/deal-status');

let sequence = 0;
const nextId = () => String(700000000000000000n + BigInt(++sequence));
function fixture(method, amount, unit) {
    const guildId = nextId();
    const sent = { dm: [], replies: [] };
    const buyer = { id: nextId(), tag: 'Buyer', bot: false, createdAt: new Date('2020-01-01') };
    const seller = { id: nextId(), tag: 'Seller', bot: false, createdAt: new Date('2020-01-01'), send: async payload => { sent.dm.push(payload); } };
    const buyerMember = { id: buyer.id };
    const sellerMember = { id: seller.id };
    const bot = { id: nextId() };
    const hub = { id: nextId(), type: ChannelType.GuildText, permissionsFor: () => new PermissionsBitField(REQUIRED_HUB_PERMISSIONS) };
    const guild = { id: guildId, name: 'Minecraft Market',
        members: { fetchMe: async () => bot, fetch: async id => id === seller.id ? sellerMember : buyerMember },
        channels: { fetch: async () => hub } };
    const interaction = {
        guildId, guild, channelId: hub.id, user: buyer, member: buyerMember,
        options: {
            getString: name => ({ item: 'Menace Cape', payment: method, unit })[name],
            getNumber: () => amount,
            getUser: () => seller,
        },
        replied: false, deferred: false,
        deferReply: async function () { this.deferred = true; },
        reply: async function (payload) { this.replied = true; sent.replies.push(payload); },
        editReply: async function (payload) { this.replied = true; sent.replies.push(payload); },
    };
    setHubChannel(guildId, hub.id);
    return { interaction, sent };
}

beforeEach(() => db.exec('DELETE FROM escrow_events; DELETE FROM escrow_transactions; DELETE FROM users; DELETE FROM guild_settings;'));
after(() => db.close());

test('/deal exposes one fixed method and a numeric total amount instead of free-form prices', () => {
    const data = create.data.toJSON();
    const names = data.options.map(option => option.name);
    assert.deepEqual(names, ['seller', 'item', 'payment', 'amount', 'unit', 'public-offer']);
    assert.equal(names.includes('price'), false);
    const payment = data.options.find(option => option.name === 'payment');
    assert.equal(payment.required, true);
    assert.deepEqual(payment.choices.map(choice => choice.value), ['money', 'golds', 'redblocks', 'sky1notchs']);
    const amount = data.options.find(option => option.name === 'amount');
    assert.equal(amount.type, 10);
    assert.equal(amount.required, true);
    assert.match(amount.description, /Total agreed payment.*not.*quantity/);
    assert.equal(data.options.find(option => option.name === 'unit').required, false);
    const privacy = data.options.find(option => option.name === 'public-offer');
    assert.equal(privacy.type, 5);
    assert.equal(privacy.required, false);
    assert.match(privacy.description, /offer details in the hub.*cannot receive DMs/);
});

test('/deal creates each market alternative without converting prices or stack counts', async () => {
    const examples = [
        ['money', 2, undefined, 'USD', 'each', 'Money · $2.00'],
        ['golds', 45, 'each', 'Golds', 'each', '45 Golds'],
        ['redblocks', 20, 'stacks', 'Redblocks', 'stacks', '20 stacks of Redblocks (1,280 blocks)'],
        ['sky1notchs', 20, 'each', 'Sky 1 Notchs', 'each', '20 Sky 1 Notchs'],
    ];
    for (const [method, amount, unit, currency, storedUnit, display] of examples) {
        const f = fixture(method, amount, unit);
        await create.execute(f.interaction);
        const row = db.prepare('SELECT * FROM escrow_transactions WHERE guild_id = ?').get(f.interaction.guildId);
        assert.ok(row, JSON.stringify(f.sent.replies));
        assert.equal(row.status, 'pending');
        assert.equal(row.item_description, 'Menace Cape');
        assert.equal(row.amount, amount, 'Store the agreed nominal amount, including a stack count');
        assert.equal(row.currency, currency);
        assert.equal(row.payment_unit, storedUnit);
        assert.equal(f.sent.dm.length, 1);
        const paymentField = f.sent.dm[0].embeds[0].toJSON().fields.find(field => field.name === 'Agreed Payment');
        assert.equal(paymentField.value, display);
        assert.match(f.sent.replies.at(-1).content, /sent.*via DM/);
    }
});

test('/deals and /deal-status use the same explicit payment display as the offer', async () => {
    const f = fixture('redblocks', 20, 'stacks');
    await create.execute(f.interaction);
    const row = db.prepare('SELECT * FROM escrow_transactions').get();
    const replies = [];
    const privateInteraction = {
        guildId: f.interaction.guildId, channelId: f.interaction.channelId,
        user: f.interaction.user, member: f.interaction.member,
        options: { getString: name => name === 'reference' ? row.transaction_uuid : null, getInteger: () => 1 },
        reply: async payload => { replies.push(payload); },
    };
    await deals.execute(privateInteraction);
    await status.execute(privateInteraction);
    for (const payload of replies) {
        assert.equal(payload.ephemeral, true);
        assert.ok(JSON.stringify(payload.embeds[0].toJSON()).includes('20 stacks of Redblocks (1,280 blocks)'));
    }
});


test('/deal keeps a failed seller DM private unless public-offer is explicitly true', async () => {
    for (const allowPublicOffer of [undefined, false, true]) {
        const f = fixture('redblocks', 20, 'stacks');
        const hub = await f.interaction.guild.channels.fetch();
        const hubPosts = [];
        hub.send = async payload => { hubPosts.push(payload); return { url: 'https://discord.com/channels/guild/hub/offer' }; };
        f.interaction.options.getUser().send = async () => { throw new Error('Closed seller DMs'); };
        if (allowPublicOffer !== undefined) f.interaction.options.getBoolean = () => allowPublicOffer;
        await create.execute(f.interaction);
        const row = db.prepare('SELECT * FROM escrow_transactions WHERE guild_id = ?').get(f.interaction.guildId);
        assert.equal(row.status, allowPublicOffer === true ? 'pending' : 'cancelled');
        assert.equal(hubPosts.length, allowPublicOffer === true ? 1 : 0);
        if (allowPublicOffer === true) {
            assert.match(f.sent.replies.at(-1).content, /posted in the escrow hub/);
            assert.ok(JSON.stringify(hubPosts[0].embeds[0].toJSON()).includes('20 stacks of Redblocks (1,280 blocks)'));
        } else {
            assert.match(f.sent.replies.at(-1).content, /cancelled.*public-offer:true/);
        }
    }
});
