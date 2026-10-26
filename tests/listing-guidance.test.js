const test = require('node:test');
const assert = require('node:assert/strict');
const command = require('../src/commands/general/listing-format');
const { parseListing, calculateListingPayment, LISTING_TEMPLATE } = require('../src/utils/listings');
const { parseCatalog } = require('../src/utils/catalog');

test('/listing-format presents optional simple prices and separate decorated product and pack offers', async () => {
    const replies = [];
    await command.execute({ guildId: 'guild-a', reply: async payload => replies.push(payload) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
    const embed = replies[0].embeds[0].toJSON();
    const templateField = embed.fields.find(field => field.name === 'Optional Simple Template');
    assert.ok(templateField.value.includes(LISTING_TEMPLATE));
    assert.equal(parseListing(LISTING_TEMPLATE).options.length, 4);
    const example = embed.fields.find(field => field.name === 'Example: Accept Golds Only').value.match(/```text\n([\s\S]*?)\n```/)[1];
    const listing = parseListing(example);
    assert.deepEqual(listing.options.map(option => option.key), ['golds']);
    assert.equal(calculateListingPayment(listing, 'golds', 2).amount, 66);
    const exampleText = name => embed.fields.find(field => field.name === name).value.match(/```text\n([\s\S]*?)\n```/)[1];
    const ranks = parseCatalog(exampleText('Example: Several Products'));
    assert.deepEqual(ranks.products.map(product => product.item), ['Special Rank', 'Emerald Rank']);
    assert.equal(ranks.products[0].options.find(option => option.key === 'golds').amount, 352);
    assert.equal(ranks.products[1].options.find(option => option.key === 'golds').amount, 84);
    const books = parseCatalog(exampleText('Example: Separate Pack Offers'));
    assert.deepEqual(books.products.map(product => product.bundleQuantity), [3, 9]);
    assert.deepEqual(books.products.map(product => product.stock), [26, 26]);
    assert.equal(calculateListingPayment(books.products[1], 'sky1notchs', 2).amount, 10);
    const output = JSON.stringify(embed);
    assert.match(output, /does not enforce/);
    assert.match(output, /1 to 999/);
    assert.match(output, /15 minutes/);
    assert.match(output, /not exchange rates/);
    assert.match(output, /Preview Listing/);
    assert.match(output, /Markdown/);
    assert.match(output, /positive stock.*not a reservation/);
    assert.doesNotMatch(output, /Post one product per message|no duplicate methods or extra text/);
    assert.ok(output.length < 6000);
});

test('/listing-format is server-only and responds privately without fetching Discord resources', async () => {
    assert.equal(command.data.toJSON().dm_permission, false);
    const replies = [];
    await command.execute({ guildId: null, reply: async payload => replies.push(payload) });
    assert.equal(replies[0].ephemeral, true);
    assert.match(replies[0].content, /inside your server/);
});
