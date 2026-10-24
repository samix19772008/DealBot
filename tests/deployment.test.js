process.env.DATABASE_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Routes } = require('discord.js');
const { deploymentOptions, deployCommands, commandDefinitions } = require('../deploy-commands');
const { clearGlobalCommands } = require('../clear-global-commands');

const settings = { DISCORD_TOKEN: 'offline-test-only', CLIENT_ID: '100000000000000001', GUILD_ID: '200000000000000001' };
const definitions = () => [{ name: 'offline-test' }];
function client() {
    const calls = [];
    return { calls, put: async (route, payload) => { calls.push({ route, payload }); } };
}

test('deployment defaults to one server and rejects unknown options before registration', async () => {
    assert.deepEqual(deploymentOptions([]), { dryRun: false, scope: 'guild' });
    const rest = client();
    await assert.rejects(deployCommands({ argv: ['--globall'], values: settings, restClient: rest, definitions }), /Use --dry-run/);
    assert.equal(rest.calls.length, 0);
});

test('server registration targets only the configured guild', async () => {
    const rest = client();
    await deployCommands({ argv: [], values: settings, restClient: rest, definitions, log: () => {} });
    assert.equal(rest.calls.length, 1);
    assert.equal(rest.calls[0].route, Routes.applicationGuildCommands(settings.CLIENT_ID, settings.GUILD_ID));
    assert.deepEqual(rest.calls[0].payload.body, definitions());
});

test('global registration uses the application route and does not require a guild binding', async () => {
    const rest = client();
    const values = { DISCORD_TOKEN: settings.DISCORD_TOKEN, CLIENT_ID: settings.CLIENT_ID };
    await deployCommands({ argv: ['--global'], values, restClient: rest, definitions, log: () => {} });
    assert.equal(rest.calls.length, 1);
    assert.equal(rest.calls[0].route, Routes.applicationCommands(settings.CLIENT_ID));
});

test('both deployment scopes validate offline without credentials or HTTP', async () => {
    for (const argv of [['--dry-run'], ['--dry-run', '--global']]) {
        const rest = client();
        const messages = [];
        const result = await deployCommands({ argv, values: {}, restClient: rest, definitions, log: value => messages.push(value) });
        assert.deepEqual(result, definitions());
        assert.equal(rest.calls.length, 0);
        assert.match(messages[0], argv.includes('--global') ? /global command/ : /guild command/);
    }
});

test('missing scope-specific configuration never attempts registration', async () => {
    const rest = client();
    await assert.rejects(deployCommands({ argv: [], values: { ...settings, GUILD_ID: '' }, restClient: rest, definitions }), /GUILD_ID/);
    await assert.rejects(deployCommands({ argv: ['--global'], values: { CLIENT_ID: settings.CLIENT_ID }, restClient: rest, definitions }), /DISCORD_TOKEN/);
    assert.equal(rest.calls.length, 0);
});

test('actual global command definitions retain server-only privacy restrictions', () => {
    const commands = commandDefinitions();
    assert.ok(commands.some(command => command.name === 'deal'));
    assert.ok(commands.some(command => command.name === 'setup'));
    assert.ok(commands.some(command => command.name === 'stats'));
    assert.ok(commands.some(command => command.name === 'review-flag'));
    for (const command of commands) assert.equal(command.dm_permission, false, command.name);
});

test('global command removal requires explicit confirmation and missing configuration cannot trigger it', async () => {
    const rest = client();
    await assert.rejects(clearGlobalCommands({ argv: [], values: settings, restClient: rest }), /--confirm/);
    await assert.rejects(clearGlobalCommands({ argv: ['--confirm'], values: {}, restClient: rest }), /Missing configuration/);
    assert.equal(rest.calls.length, 0);
});

test('explicit global command removal affects only the application command route', async () => {
    const rest = client();
    await clearGlobalCommands({ argv: ['--confirm'], values: settings, restClient: rest, log: () => {} });
    assert.deepEqual(rest.calls, [{ route: Routes.applicationCommands(settings.CLIENT_ID), payload: { body: [] } }]);
});
