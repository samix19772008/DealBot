const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { db } = require('../../database/init');
const { getEscrowById } = require('../../database/escrowRepository');
const { isModerator } = require('../../utils/permissions');
const { MAX_TRANSCRIPT_BYTES } = require('../../database/transcriptDeliveryRepository');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('transcript')
        .setDescription('Privately download a saved archived deal transcript, even with closed DMs')
        .setDMPermission(false)
        .addStringOption(option => option.setName('reference')
            .setDescription('The ESC- reference or numeric deal ID').setMinLength(1).setMaxLength(50).setRequired(true)),
    async execute(interaction) {
        const reference = interaction.options.getString('reference')?.trim();
        const escrow = reference && getEscrowById(reference);
        const participant = escrow && [escrow.buyer_discord_id, escrow.seller_discord_id].includes(interaction.user.id);
        const moderator = interaction.guildId && isModerator(interaction.member, interaction.guildId);
        if (!interaction.guildId || !escrow || escrow.guild_id !== interaction.guildId || (!participant && !moderator)) {
            return interaction.reply({ content: 'This deal was not found, or you do not have permission to view its transcript.',
                ephemeral: true, allowedMentions: { parse: [] } });
        }
        await interaction.deferReply({ ephemeral: true });
        const archive = db.prepare(`SELECT generation_status, html, filename, ready_summary_json
            FROM transcript_delivery_archives WHERE escrow_id = ? ORDER BY archive_timestamp DESC, id DESC LIMIT 1`).get(escrow.id);
        if (!archive) {
            return interaction.editReply({ content: 'No saved transcript is available for this deal. Files are captured when a conversation is archived; earlier versions may not have saved a copy.', allowedMentions: { parse: [] } });
        }
        if (archive.generation_status !== 'ready' || !Buffer.isBuffer(archive.html) || !archive.html.length || archive.html.length > MAX_TRANSCRIPT_BYTES) {
            return interaction.editReply({ content: archive.generation_status === 'pending'
                ? 'The conversation file is still being prepared. Please try again later; automatic capture retries continue while the original archive is accessible.'
                : 'The conversation file could not be captured for this archive. Use /deal-status to review its saved deal information.',
            allowedMentions: { parse: [] } });
        }
        const summary = JSON.parse(archive.ready_summary_json);
        return interaction.editReply({ ...summary,
            content: `Saved transcript for \`${escrow.transaction_uuid}\`. This private download works independently of DM delivery.`,
            files: [new AttachmentBuilder(Buffer.from(archive.html), { name: archive.filename })],
            allowedMentions: { parse: [] },
        });
    },
};
