const { createHash } = require('node:crypto');
const { AttachmentBuilder } = require('discord.js');
const discordTranscripts = require('discord-html-transcripts');
const { getEscrowByChannelId } = require('../database/escrowRepository');
const { recordThreadArchive } = require('../database/transcriptRepository');
const { buildTranscriptSummary, transcriptFilename } = require('../utils/transcriptPresentation');
const { createTranscriptDeliveryRepository, MAX_TRANSCRIPT_BYTES, errorCode } = require('../database/transcriptDeliveryRepository');

const TRANSCRIPT_LIMIT = 10000;
const HEARTBEAT_MS = 30_000;

function plainSummary(summary) {
    return {
        ...summary,
        embeds: summary.embeds?.map(embed => typeof embed.toJSON === 'function' ? embed.toJSON() : embed) || [],
        components: summary.components?.map(row => typeof row.toJSON === 'function' ? row.toJSON() : row) || [],
        allowedMentions: { parse: [] },
    };
}

function unavailable(code) {
    return Object.assign(new Error('The original archived conversation is unavailable.'), { code, unavailable: true });
}

function nonceFor(archiveId, recipientId, mode) {
    return createHash('sha256').update(`deal-transcript:${archiveId}:${recipientId}:${mode}`).digest('hex').slice(0, 24);
}

function createTranscriptService({
    createTranscript = discordTranscripts.createTranscript,
    findEscrow = getEscrowByChannelId,
    recordArchive = recordThreadArchive,
    repository = createTranscriptDeliveryRepository(),
    logger = console,
    clock = Date.now,
} = {}) {
    const inFlight = new Map();
    let queueTask = null;
    let paused = false;

    function summaries(archive, client, thread) {
        if (archive.summary_json !== '{}') return archive;
        const escrow = JSON.parse(archive.escrow_json);
        const closure = JSON.parse(archive.closure_json);
        const details = { escrow, closure, guild: thread?.guild || client.guilds?.cache?.get(archive.guild_id),
            clientUser: client.user, closerUser: client.users.cache?.get(closure.actor_discord_id) };
        return repository.enrichArchive(archive.id, {
            summary: plainSummary(buildTranscriptSummary({ ...details, hasTranscript: false })),
            readySummary: plainSummary(buildTranscriptSummary({ ...details, hasTranscript: true })),
        });
    }

    async function withLease(job, renew, operation) {
        let owned = true;
        const timer = setInterval(() => {
            try { owned = renew(job, clock()); }
            catch (error) { owned = false; logger.warn('[TRANSCRIPT] Could not renew a processing lease:', errorCode(error)); }
        }, HEARTBEAT_MS);
        timer.unref?.();
        try { return await operation(() => owned && renew(job, clock())); }
        finally { clearInterval(timer); }
    }

    async function currentThread(archive, client, suppliedThread) {
        let thread;
        if (typeof client.channels?.fetch === 'function') {
            try { thread = await client.channels.fetch(archive.thread_id, { force: true }); }
            catch (error) {
                if ([10003, 10004, 50001, 50013].includes(Number(error.code))) throw unavailable('SourceUnavailable');
                throw error;
            }
        } else thread = suppliedThread;
        if (!thread) throw unavailable('SourceUnavailable');
        if (thread.id !== archive.thread_id || thread.guildId !== archive.guild_id ||
            thread.archived !== true || thread.archiveTimestamp !== archive.archive_timestamp) {
            throw unavailable('ArchiveChanged');
        }
        return thread;
    }

    async function generate(archiveId, client, suppliedThread) {
        if (paused || client.dealBotStopping) return false;
        const job = repository.claimGeneration(archiveId, clock());
        if (!job) return false;
        await withLease(job, repository.renewGeneration, async ownsLease => {
            try {
                const thread = await currentThread(job, client, suppliedThread);
                if (paused || client.dealBotStopping) { repository.releaseGeneration(job, clock()); return; }
                summaries(job, client, thread);
                const attachment = await createTranscript(thread, {
                    limit: TRANSCRIPT_LIMIT, returnType: 'attachment',
                    filename: job.filename, saveImages: false, poweredBy: false,
                });
                const html = Buffer.isBuffer(attachment) ? attachment : attachment?.attachment;
                if (!Buffer.isBuffer(html) || !html.length) throw unavailable('InvalidTranscriptArtifact');
                if (html.length > MAX_TRANSCRIPT_BYTES) throw unavailable('TranscriptTooLarge');
                // A conversation reopened during the export must not be attached
                // to its earlier archive. Force a second observation before saving.
                await currentThread(job, client, suppliedThread);
                if (!ownsLease()) return;
                repository.finishGeneration(job, { html, now: clock() });
            } catch (error) {
                if (!ownsLease()) return;
                repository.finishGeneration(job, { error, unavailable: error.unavailable === true, now: clock() });
                logger.error('[TRANSCRIPT] Could not capture the conversation file:', errorCode(error));
            }
        });
        return true;
    }

    async function sendRecipient(recipientId, client) {
        if (paused || client.dealBotStopping) return null;
        const job = repository.claimRecipient(recipientId, clock());
        if (!job) return null;
        return withLease(job, repository.renewRecipient, async ownsLease => {
            let archive = summaries(job.archive, client);
            // Keep the claimed delivery phase stable if another worker finishes
            // capture while this recipient is being prepared.
            const hasTranscript = job.mode !== 'summary' && archive.generation_status === 'ready';
            let payload;
            if (job.mode === 'html') {
                payload = { content: 'The conversation file for your earlier deal summary is now available.', allowedMentions: { parse: [] } };
            } else {
                payload = JSON.parse(hasTranscript ? archive.ready_summary_json : archive.summary_json);
                if (archive.generation_error === 'TranscriptTooLarge') {
                    for (const embed of payload.embeds || []) {
                        for (const field of embed.fields || []) {
                            if (field.name === 'Transcript') field.value = 'The conversation file exceeds the attachment size limit. Your deal summary is preserved here.';
                        }
                    }
                }
            }
            payload.files = hasTranscript ? [new AttachmentBuilder(Buffer.from(archive.html), { name: archive.filename })] : [];
            payload.allowedMentions = { parse: [] };
            payload.nonce = nonceFor(archive.id, job.recipient_id, job.mode);
            payload.enforceNonce = true;
            try {
                const user = await client.users.fetch(job.recipient_id);
                if (paused || client.dealBotStopping) { repository.releaseRecipient(job, clock()); return null; }
                if (!ownsLease()) return null;
                const message = await user.send(payload);
                repository.finishRecipient(job, { messageId: message?.id, now: clock() });
                return { recipientId: job.recipient_id, delivered: true, hasTranscript };
            } catch (error) {
                repository.finishRecipient(job, { error, now: clock() });
                logger.warn('[TRANSCRIPT] A participant could not receive the transcript:', errorCode(error));
                return { recipientId: job.recipient_id, delivered: false, hasTranscript };
            }
        });
    }

    async function sendArchive(archiveId, client) {
        const delivered = [];
        const failed = [];
        for (const id of repository.dueRecipients({ archiveId, now: clock(), limit: 2 })) {
            const outcome = await sendRecipient(id, client);
            if (outcome) (outcome.delivered ? delivered : failed).push(outcome.recipientId);
        }
        const archive = repository.getArchive(archiveId);
        return { delivered, failed, hasTranscript: archive?.generation_status === 'ready' };
    }

    async function captureAndSend(thread, observedTimestamp) {
        const escrow = findEscrow(thread.id);
        if (!escrow || thread.guildId !== escrow.guild_id) return { skipped: true };
        // Putting an ongoing conversation away is a visibility action, not a
        // closure. Its messages remain in Discord for the eventual final export.
        if (!['completed', 'cancelled', 'refunded'].includes(escrow.status)) return { skipped: true };
        const closure = recordArchive(escrow.id, observedTimestamp);
        const archive = repository.enqueue({ escrow, closure, filename: transcriptFilename(escrow), now: clock() });
        const all = repository.recipients(archive.id);
        if (all.every(recipient => recipient.status !== 'pending')) return { skipped: true };
        if (paused || thread.client.dealBotStopping) return { queued: true };
        summaries(archive, thread.client, thread);
        await generate(archive.id, thread.client, thread);
        return sendArchive(archive.id, thread.client);
    }

    async function deliver(thread, archiveTimestamp) {
        const observedTimestamp = archiveTimestamp ?? thread.archiveTimestamp;
        if (!thread.archived || !Number.isSafeInteger(observedTimestamp) || observedTimestamp <= 0) return { skipped: true };
        const key = `${thread.id}:${observedTimestamp}`;
        if (inFlight.has(key)) return inFlight.get(key);
        const task = Promise.resolve().then(() => captureAndSend(thread, observedTimestamp));
        inFlight.set(key, task);
        try { return await task; }
        finally { inFlight.delete(key); }
    }

    async function processQueue(client, { limit = 5 } = {}) {
        if (paused || client.dealBotStopping) return { skipped: true };
        if (queueTask) return queueTask;
        queueTask = (async () => {
            let generated = 0;
            const delivered = [];
            const failed = [];
            for (const archiveId of repository.dueArchives({ limit, now: clock() })) {
                if (paused || client.dealBotStopping) break;
                try { if (await generate(archiveId, client)) generated++; }
                catch (error) { logger.error('[TRANSCRIPT] Archive processing failed:', errorCode(error)); }
            }
            for (const recipientId of repository.dueRecipients({ limit: Math.min(100, limit * 2), now: clock() })) {
                if (paused || client.dealBotStopping) break;
                try {
                    const outcome = await sendRecipient(recipientId, client);
                    if (outcome) (outcome.delivered ? delivered : failed).push(outcome.recipientId);
                } catch (error) { logger.error('[TRANSCRIPT] Delivery processing failed:', errorCode(error)); }
            }
            return { generated, delivered, failed };
        })();
        try { return await queueTask; }
        finally { queueTask = null; }
    }

    async function waitForIdle() {
        await Promise.allSettled([...inFlight.values(), ...(queueTask ? [queueTask] : [])]);
    }
    async function stop() {
        paused = true;
        await waitForIdle();
    }
    return { deliver, processQueue, waitForIdle, stop };
}

const service = createTranscriptService();
module.exports = { createTranscriptService, deliverThreadTranscript: service.deliver,
    processTranscriptQueue: service.processQueue, waitForTranscriptIdle: service.waitForIdle,
    stopTranscriptService: service.stop, getTranscriptQueueStats: () => createTranscriptDeliveryRepository().getQueueStats(),
    TRANSCRIPT_LIMIT, nonceFor };
