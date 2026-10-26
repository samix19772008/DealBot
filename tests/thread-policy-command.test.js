process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { getThreadCleanupMinutes } = require('../src/database/guildSettingsRepository');
const command = require('../src/commands/general/set-thread-policy');

beforeEach(() => db.exec('DELETE FROM guild_settings;'));
after(() => db.close());

function input({ guildId = 'market', admin = true, minutes = 15 } = {}) {
    const replies = [];
    return { guildId, memberPermissions: new PermissionsBitField(admin ? [PermissionFlagsBits.Administrator] : []),
        options: { getInteger: name => name === 'archive-after' ? minutes : null }, replies, reply: async payload => { replies.push(payload); } };
}

test('thread cleanup policy requires an administrator in a server before changing settings', async () => {
    for (const options of [{ admin: false }, { guildId: null }]) {
        const interaction = input(options);
        await command.execute(interaction);
        assert.match(interaction.replies[0].content, /administrators/);
        assert.equal(interaction.replies[0].ephemeral, true);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guild_settings').get().count, 0);
});

test('thread cleanup command changes only its server and truthfully explains retained history', async () => {
    const interaction = input();
    await command.execute(interaction);
    assert.equal(getThreadCleanupMinutes('market'), 15);
    assert.equal(getThreadCleanupMinutes('other-market'), 30);
    const reply = interaction.replies[0];
    assert.equal(reply.ephemeral, true);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    assert.match(reply.content, /15 minutes/);
    assert.match(reply.content, /Disputed deals are excluded/);
    assert.match(reply.content, /Records and saved transcripts are kept/);
    assert.match(reply.content, /no channels are deleted/);
    const disable = input({ minutes: 0 });
    await command.execute(disable);
    assert.equal(getThreadCleanupMinutes('market'), 0);
    assert.match(disable.replies[0].content, /disabled/);
});

test('invalid thread policy values do not mutate the default', async () => {
    for (const minutes of [-1, 10, 30.5, '30']) {
        const interaction = input({ minutes });
        await command.execute(interaction);
        assert.equal(getThreadCleanupMinutes('market'), 30);
        assert.match(interaction.replies[0].content, /Choose a finished-chat archive delay/);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guild_settings').get().count, 0);
});
