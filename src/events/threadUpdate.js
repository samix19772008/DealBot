const { Events } = require('discord.js');
const discordTranscripts = require('discord-html-transcripts');
const { getEscrowByChannelId } = require('../database/escrowRepository');
const { buildDealEmbed } = require('../utils/embedTemplate');

const exporting = new Set();
const TRANSCRIPT_LIMIT = 10000;

module.exports = {
    name: Events.ThreadUpdate,
    async execute(oldThread, newThread) {
        if (oldThread.archived || !newThread.archived || exporting.has(newThread.id)) return;
        const escrow = getEscrowByChannelId(newThread.id);
        if (!escrow || newThread.guildId !== escrow.guild_id) return;
        exporting.add(newThread.id);
        try {
            const attachment = await discordTranscripts.createTranscript(newThread, {
                limit: TRANSCRIPT_LIMIT,
                returnType: 'attachment',
                filename: `transcript-${escrow.transaction_uuid}.html`,
                saveImages: false,
                poweredBy: false,
            });
            const summary = buildDealEmbed({
                title: 'Conversation Transcript', referenceId: escrow.transaction_uuid, status: 'info',
                rows: [
                    { label: 'Item or Service', value: escrow.item_description },
                    { label: 'Agreed Amount', value: `${Number(escrow.amount).toLocaleString('en-US')} ${escrow.currency}` },
                    { label: 'Recorded Status at Archive', value: escrow.status.replaceAll('_', ' ') },
                    { label: 'Transcript Coverage', value: `Up to the latest ${TRANSCRIPT_LIMIT.toLocaleString('en-US')} messages. Linked attachments remain subject to Discord availability.` },
                ],
                footerNote: 'Open the attached HTML file to view the conversation',
            });
            for (const id of [escrow.buyer_discord_id, escrow.seller_discord_id]) {
                try {
                    const user = await newThread.client.users.fetch(id);
                    await user.send({ embeds: [summary], files: [attachment], allowedMentions: { parse: [] } });
                    console.log(`[TRANSCRIPT] Delivered ${escrow.transaction_uuid} to participant ${id}`);
                } catch (error) {
                    console.warn('[TRANSCRIPT] A participant could not receive the transcript:', error.code ?? error.name);
                }
            }
        } catch (error) {
            console.error('[TRANSCRIPT] Could not generate the conversation transcript:', error.code ?? error.name);
        } finally {
            exporting.delete(newThread.id);
        }
    },
    TRANSCRIPT_LIMIT,
};
