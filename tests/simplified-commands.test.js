process.env.DATABASE_PATH = ':memory:';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, ChannelType } = require('discord.js');
const { db } = require('../src/database/init');
const { commandDefinitions } = require('../deploy-commands');
const { loadCommands } = require('../src/handlers/commandHandler');
const { getGuildSettings, getThreadCleanupMinutes, getActiveThreadIdleMinutes } = require('../src/database/guildSettingsRepository');
const setup = require('../src/commands/general/setup');
const home = require('../src/commands/escrow/create');
const help = require('../src/commands/general/help');
const dashboard = require('../src/interactions/buttons/dealsDashboard');

beforeEach(() => db.exec('DELETE FROM guild_settings;'));
after(() => db.close());
const permissions = (...flags) => new PermissionsBitField(flags);
function input({ action = 'check', administrator = true, finished = null, active = null } = {}) {
    const replies = [];
    return { guildId: 'simple-market', guild: { id: 'simple-market' }, user: { id: 'buyer' }, replies,
        memberPermissions: permissions(...(administrator ? [PermissionFlagsBits.Administrator] : [])),
        options: { getSubcommand: () => action,
            getInteger: name => name === 'archive-after' ? finished : name === 'idle-after' ? active : null },
        reply: async payload => replies.push(payload),
        editReply: async payload => replies.push(payload),
        deferReply: async payload => replies.push({ deferred: true, ...payload }) };
}

test('only nine focused top-level commands are registered while compatibility handlers remain available', () => {
    const definitions = commandDefinitions();
    assert.deepEqual(definitions.map(command => command.name).sort(), ['Preview Listing', 'Request a Deal',
        'deal', 'deal-status', 'deals', 'help', 'profile', 'setup', 'transcript'].sort());
    const client = {};
    loadCommands(client);
    for (const name of ['set-hub-channel', 'set-mod-role', 'set-thread-policy', 'stats', 'review-flag']) {
        assert.ok(client.commands.has(name));
        assert.ok(!definitions.some(command => command.name === name));
    }
    assert.deepEqual(definitions.find(command => command.name === 'deal').options, []);
});

test('all server tools live under one administrator command with the original option constraints', () => {
    const definition = setup.data.toJSON();
    assert.equal(definition.dm_permission, false);
    assert.equal(definition.default_member_permissions, PermissionFlagsBits.Administrator.toString());
    assert.deepEqual(definition.options.map(option => option.name), ['check', 'hub', 'staff', 'threads', 'rank-role', 'rank', 'review-flag', 'stats']);
    const hub = definition.options.find(option => option.name === 'hub');
    assert.equal(hub.options[0].name, 'channel');
    assert.equal(hub.options[0].required, true);
    assert.deepEqual(hub.options[0].channel_types, [ChannelType.GuildText]);
    const threads = definition.options.find(option => option.name === 'threads');
    assert.deepEqual(threads.options.map(option => option.name), ['archive-after', 'idle-after']);
    assert.ok(threads.options.every(option => !option.required));
    const review = definition.options.find(option => option.name === 'review-flag');
    assert.equal(review.options.find(option => option.name === 'reason').min_length, 10);
});

test('every setup action rejects unauthorized callers before reading its options or changing settings', async () => {
    for (const action of ['check', 'hub', 'staff', 'threads', 'rank-role', 'rank', 'review-flag', 'stats']) {
        const interaction = input({ action, administrator: false });
        interaction.options.getSubcommand = () => assert.fail('Unauthorized options were read');
        await setup.execute(interaction);
        assert.match(interaction.replies[0].content, /administrators/);
        assert.equal(interaction.replies[0].ephemeral, true);
    }
    assert.equal(getGuildSettings('simple-market'), undefined);
});

test('setup hub dispatch retains effective permission checks and server-scoped persistence', async () => {
    const interaction = input({ action: 'hub' });
    const bot = { id: 'bot' };
    const channel = { id: 'chosen-hub', guildId: interaction.guildId, type: ChannelType.GuildText,
        permissionsFor: () => permissions(PermissionFlagsBits.Administrator) };
    interaction.options.getChannel = () => channel;
    interaction.guild.members = { me: bot };
    await setup.execute(interaction);
    assert.equal(getGuildSettings('simple-market').hub_channel_id, channel.id);
    assert.equal(getGuildSettings('another-market'), undefined);
    assert.equal(interaction.replies[0].ephemeral, true);
    assert.match(interaction.replies.at(-1), /now the escrow hub/);
    channel.guildId = 'another-market';
    channel.id = 'foreign-hub';
    await setup.execute(interaction);
    assert.equal(getGuildSettings('simple-market').hub_channel_id, 'chosen-hub');
    assert.match(interaction.replies.at(-1).content, /this server/);
});

test('thread policies are updated atomically and omitted options keep the existing settings', async () => {
    const invalid = input({ action: 'threads', finished: 15, active: 7 });
    await setup.execute(invalid);
    assert.match(invalid.replies[0].content, /active-chat idle delay/);
    assert.equal(getGuildSettings('simple-market'), undefined);
    const valid = input({ action: 'threads', finished: 0, active: 5 });
    await setup.execute(valid);
    assert.equal(getThreadCleanupMinutes('simple-market'), 0);
    assert.equal(getActiveThreadIdleMinutes('simple-market'), 5);
    assert.equal(getActiveThreadIdleMinutes('another-market'), 15);
    const partial = input({ action: 'threads', finished: 60 });
    await setup.execute(partial);
    assert.equal(getThreadCleanupMinutes('simple-market'), 60);
    assert.equal(getActiveThreadIdleMinutes('simple-market'), 5);
    const snapshot = getGuildSettings('simple-market');
    const readOnly = input({ action: 'threads' });
    await setup.execute(readOnly);
    assert.deepEqual(getGuildSettings('simple-market'), snapshot);
    assert.match(readOnly.replies[0].content, /current settings/);
    assert.match(readOnly.replies[0].content, /no channels are deleted/);
});

test('deal and help give a private simple start with a working owner-bound My Deals action', async () => {
    for (const command of [home, help]) {
        const interaction = input();
        interaction.options = new Proxy({}, { get: () => assert.fail('The simple start must not request form options') });
        await command.execute(interaction);
        const payload = interaction.replies[0];
        assert.equal(payload.ephemeral, true);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        assert.match(JSON.stringify(payload.embeds[0].toJSON()), /Apps → Request a Deal/);
        assert.doesNotMatch(JSON.stringify(payload.embeds[0].toJSON()), /public-offer|seller:@|amount:/);
        const button = payload.components[0].toJSON().components[0];
        assert.equal(button.label, 'My Deals');
        const updates = [];
        await dashboard.execute({ guildId: interaction.guildId, user: interaction.user,
            customId: button.custom_id, update: async update => updates.push(update) });
        assert.equal(updates.length, 1);
        const denied = [];
        await dashboard.execute({ guildId: interaction.guildId, user: { id: 'another-user' },
            customId: button.custom_id, reply: async response => denied.push(response) });
        assert.equal(denied[0].ephemeral, true);
        assert.match(denied[0].content, /another user or server/);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM escrow_transactions').get().count, 0);
});
