const test = require('node:test');
const assert = require('node:assert/strict');
const command = require('../src/commands/general/listing-format');
const { parseListing, calculateListingPayment, LISTING_TEMPLATE } = require('../src/utils/listings');

test('/listing-format gives sellers a parser-compatible template and a restricted single-method example', async () => {
    const replies = [];
    await command.execute({ guildId: 'guild-a', reply: async payload => replies.push(payload) });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ephemeral, true);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
    const embed = replies[0].embeds[0].toJSON();
    const templateField = embed.fields.find(field => field.name === 'Copy and Edit This Template');
    assert.ok(templateField.value.includes(LISTING_TEMPLATE));
    assert.equal(parseListing(LISTING_TEMPLATE).options.length, 4);
    const example = embed.fields.find(field => field.name === 'Example: Accept Golds Only').value.match(/```text\n([\s\S]*?)\n```/)[1];
    const listing = parseListing(example);
    assert.deepEqual(listing.options.map(option => option.key), ['golds']);
    assert.equal(calculateListingPayment(listing, 'golds', 2).amount, 66);
    const output = JSON.stringify(embed);
    assert.match(output, /does not enforce/);
    assert.match(output, /1 to 999/);
    assert.match(output, /15 minutes/);
    assert.match(output, /not exchange rates/);
    assert.ok(output.length < 6000);
});

test('/listing-format is server-only and responds privately without fetching Discord resources', async () => {
    assert.equal(command.data.toJSON().dm_permission, false);
    const replies = [];
    await command.execute({ guildId: null, reply: async payload => replies.push(payload) });
    assert.equal(replies[0].ephemeral, true);
    assert.match(replies[0].content, /inside your server/);
});
