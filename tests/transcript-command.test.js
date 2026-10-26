process.env.DATABASE_PATH = ':memory:';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const { createEscrow, acceptEscrow } = require('../src/database/escrowRepository');
const { recordThreadArchive } = require('../src/database/transcriptRepository');
const { createTranscriptDeliveryRepository } = require('../src/database/transcriptDeliveryRepository');
const { setModeratorRole } = require('../src/database/guildSettingsRepository');
const command = require('../src/commands/escrow/transcript');

let sequence = 0;
const nextId = () => String(920000000000000000n + BigInt(++sequence));
const repository = createTranscriptDeliveryRepository();
after(() => db.close());

function fixture({ saved = true, ready = true } = {}) {
    const guildId = nextId();
    const buyer = getOrCreateUser({ id: nextId(), tag: 'Buyer', createdAt: new Date('2020-01-01') });
    const seller = getOrCreateUser({ id: nextId(), tag: 'Seller', createdAt: new Date('2020-01-01') });
    const escrow = createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id, itemDescription: 'Cape', amount: 2 });
    acceptEscrow(escrow.id, nextId(), seller.discord_id);
    const html = Buffer.from('<html><body>Private deal conversation</body></html>');
    let archive;
    if (saved) {
        recordThreadArchive(escrow.id, Date.now());
        archive = db.prepare('SELECT * FROM transcript_delivery_archives WHERE escrow_id = ?').get(escrow.id);
        assert.ok(archive, 'Archive observation must durably queue capture before event delivery');
        if (ready) {
            const job = repository.claimGeneration(archive.id);
            assert.ok(job);
            repository.finishGeneration(job, { html });
            repository.enrichArchive(archive.id, { summary: {}, readySummary: {
                embeds: [{ title: 'Deal Transcript', description: escrow.transaction_uuid }],
                components: [], allowedMentions: { parse: [] },
            } });
        }
    }
    const calls = [];
    const interaction = { guildId, user: { id: buyer.discord_id },
        member: { guild: { id: guildId }, permissions: new PermissionsBitField(), roles: { cache: new Map() } },
        options: { getString: () => escrow.transaction_uuid },
        reply: async payload => { calls.push({ kind: 'reply', ...payload }); },
        deferReply: async payload => { calls.push({ kind: 'defer', ...payload }); },
        editReply: async payload => { calls.push({ kind: 'edit', ...payload }); } };
    return { interaction, calls, guildId, buyer, seller, escrow, html, archive };
}

test('participants can privately retrieve the stored HTML without DM access or a Discord source fetch', async () => {
    const f = fixture();
    for (const id of [f.buyer.discord_id, f.seller.discord_id]) {
        f.interaction.user.id = id;
        await command.execute(f.interaction);
        assert.equal(f.calls.at(-2).kind, 'defer');
        assert.equal(f.calls.at(-2).ephemeral, true);
        const payload = f.calls.at(-1);
        assert.deepEqual(payload.files[0].attachment, f.html);
        assert.match(payload.files[0].name, /^transcript-cape-\d+\.html$/);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        assert.match(payload.content, /independently of DM delivery/);
        assert.equal(repository.recipients(f.archive.id).every(row => row.status === 'pending'), true,
            'A private download must not falsely mark a DM as delivered');
    }
});

test('other users, another server, and DMs cannot retrieve a private archived conversation', async () => {
    for (const modify of [
        f => { f.interaction.user.id = nextId(); },
        f => { f.interaction.guildId = nextId(); },
        f => { f.interaction.guildId = null; },
    ]) {
        const f = fixture();
        modify(f);
        await command.execute(f.interaction);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].ephemeral, true);
        assert.match(f.calls[0].content, /not found|permission/);
        assert.equal(f.calls[0].files, undefined);
    }
});

test('configured local staff and administrators can retrieve evidence while unrelated roles cannot', async () => {
    const f = fixture();
    const roleId = nextId();
    setModeratorRole(f.guildId, roleId);
    f.interaction.user.id = nextId();
    f.interaction.member.roles.cache.set(roleId, { id: roleId });
    await command.execute(f.interaction);
    assert.deepEqual(f.calls.at(-1).files[0].attachment, f.html);
    f.interaction.member.roles.cache.clear();
    f.interaction.member.permissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
    await command.execute(f.interaction);
    assert.deepEqual(f.calls.at(-1).files[0].attachment, f.html);
    f.interaction.member.guild.id = nextId();
    await command.execute(f.interaction);
    assert.match(f.calls.at(-1).content, /permission/);
    assert.equal(f.calls.at(-1).files, undefined);
});

test('missing, pending and unavailable artifacts give truthful private outcomes without fabricated HTML', async () => {
    const missing = fixture({ saved: false });
    await command.execute(missing.interaction);
    assert.match(missing.calls.at(-1).content, /No saved transcript/);
    const f = fixture({ ready: false });
    await command.execute(f.interaction);
    assert.match(f.calls.at(-1).content, /still being prepared/);
    const job = repository.claimGeneration(f.archive.id);
    repository.finishGeneration(job, { unavailable: true, error: { code: 'ArchiveChanged' } });
    await command.execute(f.interaction);
    assert.match(f.calls.at(-1).content, /could not be captured/);
    for (const payload of [...f.calls, ...missing.calls]) assert.equal(payload.files, undefined);
});
