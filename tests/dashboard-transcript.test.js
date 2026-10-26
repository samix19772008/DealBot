process.env.DATABASE_PATH = ':memory:';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const { db } = require('../src/database/init');
const { getOrCreateUser } = require('../src/database/userRepository');
const escrows = require('../src/database/escrowRepository');
const { recordThreadArchive } = require('../src/database/transcriptRepository');
const { createTranscriptDeliveryRepository } = require('../src/database/transcriptDeliveryRepository');
const { setModeratorRole } = require('../src/database/guildSettingsRepository');
const button = require('../src/interactions/buttons/dealsTranscript');
const router = require('../src/events/interactionCreate');
after(() => db.close());

let sequence = 0;
const nextId = () => String(960000000000000000n + BigInt(++sequence));
const repository = createTranscriptDeliveryRepository();

function fixture({ saved = true, ready = true } = {}) {
    const guildId = nextId();
    const user = () => getOrCreateUser({ id: nextId(), tag: 'Trader', createdAt: new Date('2020-01-01') });
    const buyer = user(); const seller = user();
    let deal = escrows.createEscrow({ guildId, buyerId: buyer.id, sellerId: seller.id, itemDescription: 'Armour Set', amount: 32, currency: 'Redblocks' });
    escrows.acceptEscrow(deal.id, nextId(), seller.discord_id);
    escrows.markAsFunded(deal.id, buyer.discord_id);
    escrows.markAsDelivered(deal.id, seller.discord_id);
    escrows.completeEscrow(deal.id, buyer.id, seller.id, buyer.discord_id);
    deal = escrows.getEscrowById(deal.id);
    let archive;
    const html = Buffer.from('<html>Private saved armour conversation</html>');
    if (saved) {
        recordThreadArchive(deal.id, Date.now());
        archive = db.prepare('SELECT * FROM transcript_delivery_archives WHERE escrow_id = ?').get(deal.id);
        if (ready) {
            repository.finishGeneration(repository.claimGeneration(archive.id), { html });
            repository.enrichArchive(archive.id, { summary: {}, readySummary: {
                embeds: [{ title: 'Deal Transcript', description: deal.transaction_uuid }], components: [],
            } });
        }
    }
    const calls = [];
    const interaction = { guildId, channelId: 'dashboard-channel', customId: `deals_transcript_${deal.id}`,
        user: { id: buyer.discord_id }, member: { guild: { id: guildId }, roles: { cache: new Map() }, permissions: new PermissionsBitField() },
        isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, isButton: () => true, isModalSubmit: () => false,
        reply: async payload => { interaction.replied = true; calls.push({ kind: 'reply', ...payload }); },
        deferReply: async payload => { interaction.deferred = true; calls.push({ kind: 'defer', ...payload }); },
        editReply: async payload => { calls.push({ kind: 'edit', ...payload }); },
        followUp: async payload => { calls.push({ kind: 'followup', ...payload }); },
    };
    return { interaction, calls, deal, buyer, seller, guildId, html, archive };
}

test('Download Transcript routes from the dashboard and privately retrieves the saved file without command options or Discord source access', async () => {
    const f = fixture();
    assert.equal(f.interaction.options, undefined);
    await router.execute(f.interaction, { buttons: [button] });
    assert.deepEqual(f.calls.map(call => call.kind), ['defer', 'edit']);
    assert.equal(f.calls[0].ephemeral, true);
    assert.deepEqual(f.calls[1].files[0].attachment, f.html);
    assert.match(f.calls[1].content, new RegExp(f.deal.transaction_uuid));
    assert.deepEqual(f.calls[1].allowedMentions, { parse: [] });
    assert.ok(repository.recipients(f.archive.id).every(recipient => recipient.status === 'pending'),
        'A button download does not claim either recipient received a DM');
});

test('foreign users, other servers, DMs and malformed button IDs cannot download private evidence', async () => {
    for (const modify of [
        f => { f.interaction.user.id = nextId(); },
        f => { f.interaction.guildId = nextId(); },
        f => { f.interaction.guildId = null; },
        f => { f.interaction.customId = 'deals_transcript_not-a-numeric-reference'; },
    ]) {
        const f = fixture(); modify(f);
        await router.execute(f.interaction, { buttons: [button] });
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].ephemeral, true);
        assert.equal(f.calls[0].files, undefined);
        assert.equal(f.calls[0].embeds, undefined);
        assert.doesNotMatch(f.calls[0].content, new RegExp(f.deal.transaction_uuid));
    }
});

test('a seller or authorized local staff member can use the same download button while a foreign guild member cannot', async () => {
    const seller = fixture(); seller.interaction.user.id = seller.seller.discord_id;
    await button.execute(seller.interaction);
    assert.deepEqual(seller.calls.at(-1).files[0].attachment, seller.html);
    const staff = fixture();
    setModeratorRole(staff.guildId, 'local-staff');
    staff.interaction.user.id = nextId();
    staff.interaction.member.roles.cache.set('local-staff', { id: 'local-staff' });
    await button.execute(staff.interaction);
    assert.deepEqual(staff.calls.at(-1).files[0].attachment, staff.html);
    const outsider = fixture();
    outsider.interaction.user.id = nextId();
    setModeratorRole(outsider.guildId, 'local-staff');
    outsider.interaction.member.roles.cache.set('local-staff', { id: 'local-staff' });
    outsider.interaction.member.guild.id = nextId();
    await button.execute(outsider.interaction);
    assert.equal(outsider.calls.length, 1);
    assert.equal(outsider.calls[0].files, undefined);
});

test('download buttons truthfully report missing and pending files instead of inventing an attachment', async () => {
    for (const options of [{ saved: false }, { ready: false }]) {
        const f = fixture(options);
        await button.execute(f.interaction);
        assert.equal(f.calls[0].ephemeral, true);
        assert.equal(f.calls.at(-1).files, undefined);
        assert.match(f.calls.at(-1).content, options.saved === false ? /No saved transcript/ : /still being prepared/);
    }
});
