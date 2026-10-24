const discordTranscripts = require('discord-html-transcripts');
const { getEscrowByChannelId } = require('../database/escrowRepository');
const { recordThreadArchive } = require('../database/transcriptRepository');
const { buildTranscriptSummary, transcriptFilename } = require('../utils/transcriptPresentation');

const TRANSCRIPT_LIMIT = 10000;

function createTranscriptService({
    createTranscript = discordTranscripts.createTranscript,
    findEscrow = getEscrowByChannelId,
    recordArchive = recordThreadArchive,
    logger = console,
} = {}) {
    const inFlight = new Map();
    const completed = new Set();

    async function send(thread, archiveTimestamp) {
        const escrow = findEscrow(thread.id);
        if (!escrow || thread.guildId !== escrow.guild_id) return { skipped: true };
        const closure = recordArchive(escrow.id, archiveTimestamp);
        let attachment;
        try {
            attachment = await createTranscript(thread, {
                limit: TRANSCRIPT_LIMIT, returnType: 'attachment',
                filename: transcriptFilename(escrow), saveImages: false, poweredBy: false,
            });
        } catch (error) {
            logger.error('[TRANSCRIPT] Could not generate the conversation file:', error.code ?? error.name);
        }
        const closer = thread.client.users.cache?.get(closure.actor_discord_id);
        const summary = buildTranscriptSummary({
            escrow, closure, guild: thread.guild, clientUser: thread.client.user,
            closerUser: closer, hasTranscript: Boolean(attachment),
        });
        const delivered = [];
        const failed = [];
        for (const id of new Set([escrow.buyer_discord_id, escrow.seller_discord_id])) {
            try {
                const user = await thread.client.users.fetch(id);
                await user.send({ ...summary, files: attachment ? [attachment] : [] });
                delivered.push(id);
            } catch (error) {
                failed.push(id);
                logger.warn('[TRANSCRIPT] A participant could not receive the transcript:', error.code ?? error.name);
            }
        }
        return { delivered, failed, hasTranscript: Boolean(attachment) };
    }

    async function deliver(thread, archiveTimestamp) {
        const observedTimestamp = archiveTimestamp ?? thread.archiveTimestamp;
        if (!thread.archived || !Number.isSafeInteger(observedTimestamp) || observedTimestamp <= 0) {
            return { skipped: true };
        }
        const key = `${thread.id}:${observedTimestamp}`;
        if (completed.has(key)) return { skipped: true };
        if (inFlight.has(key)) return inFlight.get(key);
        // Register before running any generator code: Gateway and REST archive
        // observations can arrive in either order, including during an await.
        const task = Promise.resolve().then(() => send(thread, observedTimestamp));
        inFlight.set(key, task);
        try {
            const result = await task;
            if (!result.skipped) completed.add(key);
            if (completed.size > 1000) completed.delete(completed.values().next().value);
            return result;
        } finally {
            inFlight.delete(key);
        }
    }
    return { deliver };
}

const service = createTranscriptService();
module.exports = { createTranscriptService, deliverThreadTranscript: service.deliver, TRANSCRIPT_LIMIT };
