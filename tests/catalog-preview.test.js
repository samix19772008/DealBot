process.env.DATABASE_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { parseCatalog } = require('../src/utils/catalog');
const { buildCatalogPreview } = require('../src/utils/catalogPreview');
const preview = require('../src/commands/context/previewListing');
const pages = require('../src/interactions/selects/listingPreview');
const posts = require('./fixtures/market-posts.json');

const guildId = '600000000000000001';
const channelId = '600000000000000002';
const messageId = '600000000000000003';
const authorId = '600000000000000004';

function fixture(content = posts.ranks) {
    const calls = { replies: [], edits: [], deferrals: [], reads: 0 };
    const user = { id: authorId, bot: false };
    const message = { id: messageId, channelId, author: user, content, editedTimestamp: null };
    const channel = { id: channelId, guildId, type: ChannelType.GuildText, isTextBased: () => true,
        permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]),
        messages: { fetch: async options => {
            assert.deepEqual(options, { message: messageId, force: true, cache: false });
            calls.reads++;
            return message;
        } } };
    const interaction = { user, guildId, targetMessage: message, member: { id: authorId },
        guild: { channels: { fetch: async (id, options) => {
            assert.equal(id, channelId);
            assert.deepEqual(options, { force: true });
            return channel;
        } } },
        reply: async payload => { calls.replies.push(payload); },
        deferReply: async payload => { calls.deferrals.push(payload); },
        deferUpdate: async () => { calls.deferrals.push('update'); },
        editReply: async payload => { calls.edits.push(payload); } };
    return { interaction, calls, message, channel };
}

test('seller preview reads their own current decorated post without creating a deal or pinging mentions', async () => {
    const f = fixture();
    await preview.execute(f.interaction);
    assert.deepEqual(f.calls.deferrals, [{ ephemeral: true }]);
    assert.equal(f.calls.reads, 1);
    assert.equal(f.calls.replies.length, 0);
    const output = f.calls.edits[0];
    const embed = output.embeds[0].toJSON();
    assert.ok(embed.fields.some(field => field.name === 'Special Rank' && field.value.includes('$22.00')));
    assert.ok(embed.fields.some(field => field.name === 'Emerald Rank' && field.value.includes('84 Golds')));
    assert.deepEqual(output.allowedMentions, { parse: [] });
    assert.doesNotMatch(JSON.stringify(embed), /@everyone|1430838575070580777/);
    assert.match(embed.description, /does not create a deal/);
});

test('preview rejects another author and DMs before reading a private source', async () => {
    for (const change of [f => { f.interaction.user = { id: '600000000000000009' }; }, f => { f.interaction.guildId = null; }]) {
        const f = fixture();
        change(f);
        await preview.execute(f.interaction);
        assert.equal(f.calls.reads, 0);
        assert.equal(f.calls.deferrals.length, 0);
        assert.equal(f.calls.replies[0].ephemeral, true);
    }
});

test('preview refuses lost source access before reading prices and explains unclear posts', async () => {
    const f = fixture();
    f.channel.permissionsFor = () => new PermissionsBitField();
    await preview.execute(f.interaction);
    assert.equal(f.calls.reads, 0);
    assert.match(f.calls.edits[0].content, /no longer access/);
    const unclear = fixture('Contact me for pricing!');
    await preview.execute(unclear.interaction);
    assert.match(unclear.calls.edits[0].content, /clearer price or product/);
    assert.deepEqual(unclear.calls.edits[0].components, []);
});

test('preview pages cover every detected pack and show out-of-stock offers honestly', async () => {
    const catalog = parseCatalog(posts.skypvp);
    const seen = [];
    for (let page = 0; page < Math.ceil(catalog.products.length / 5); page++) {
        const payload = buildCatalogPreview(catalog, { guildId, channelId, messageId, authorId, page });
        const embed = payload.embeds[0].toJSON();
        seen.push(...embed.fields.filter(field => field.name !== 'Needs Review').map(field => field.name));
        assert.ok(JSON.stringify(embed).length < 6000);
        const menu = payload.components[0].toJSON().components[0];
        assert.ok(menu.options.length <= 25);
        assert.ok(menu.custom_id.length <= 100);
    }
    assert.equal(seen.length, catalog.products.length);
    assert.equal(new Set(seen).size, catalog.products.length);
    const page = buildCatalogPreview(catalog, { guildId, channelId, messageId, authorId, page: 1 });
    assert.match(JSON.stringify(page.embeds[0].toJSON()), /out of stock/);
});

test('preview pagination is author-bound and re-reads the edited post on each page', async () => {
    const f = fixture(posts.skypvp);
    f.interaction.customId = `listing_preview_${channelId}_${messageId}_${authorId}`;
    f.interaction.values = ['1'];
    f.message.content = '# New Product\nMoney: $7.00';
    await pages.execute(f.interaction);
    assert.deepEqual(f.calls.deferrals, ['update']);
    assert.equal(f.calls.reads, 1);
    assert.equal(f.calls.edits[0].embeds[0].toJSON().fields[0].name, 'New Product');
    assert.match(f.calls.edits[0].embeds[0].toJSON().fields[0].value, /\$7.00/);
    f.interaction.user = { id: '600000000000000009' };
    await pages.execute(f.interaction);
    assert.equal(f.calls.reads, 1);
    assert.match(f.calls.replies.at(-1).content, /only to the author/);
});

test('one hundred detected products fit the preview page selector without exceeding Discord limits', () => {
    const source = Array.from({ length: 100 }, (_, index) => `# Product ${index + 1}\nMoney: $1.00`).join('\n');
    const payload = buildCatalogPreview(parseCatalog(source), { guildId, channelId, messageId, authorId, page: 19 });
    const embed = payload.embeds[0].toJSON();
    const menu = payload.components[0].toJSON().components[0];
    assert.equal(menu.options.length, 20);
    assert.equal(embed.fields.length, 5);
    assert.match(embed.title, /20\/20/);
});
