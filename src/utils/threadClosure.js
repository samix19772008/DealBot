const transcriptRepository = require('../database/transcriptRepository');

function archiveTimestamp(thread) {
    if (thread?.archived !== true) return null;
    const value = thread.archiveTimestamp;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function observeThread(channel) {
    if (typeof channel.fetch !== 'function') return channel;
    try { return await channel.fetch(true); }
    catch { return channel; }
}

/**
 * Persist the actor before Discord can emit its archive event. The SDK result and
 * Gateway event may arrive in either order; both record the same archive timestamp.
 * A successful archive is never rolled back because finalizing its metadata failed.
 */
async function closeDealThread({ channel, escrowId, actor, kind, reason }, repository = transcriptRepository) {
    const actorId = actor?.id;
    const actorName = actor?.tag || actor?.username || actorId;
    if (!channel || !actorId || !['participant', 'moderator'].includes(kind)) {
        throw new Error('A deal thread, actor, and valid closure kind are required.');
    }

    function emitArchive(thread, timestamp) {
        const archivedThread = thread?.archived === true ? thread : channel;
        const client = archivedThread.client || channel.client;
        try { client?.emit?.('dealThreadArchived', archivedThread, timestamp); }
        catch (error) { console.warn('[CLOSE] Could not notify transcript processing:', error.message); }
    }

    async function finalize(thread, { requestId = null, alreadyArchived = false } = {}) {
        let timestamp = archiveTimestamp(thread) || archiveTimestamp(channel);
        if (!timestamp) timestamp = archiveTimestamp(await observeThread(channel));
        if (!timestamp) {
            emitArchive(thread, null);
            return { archived: true, alreadyArchived, requestId, closure: null,
                archiveTimestamp: null, metadataPending: true,
                metadataError: new Error('Discord did not provide an archive timestamp yet.') };
        }
        try {
            const closure = repository.recordThreadArchive(escrowId, timestamp);
            emitArchive(thread, timestamp);
            return { archived: true, alreadyArchived, requestId, closure,
                archiveTimestamp: timestamp, metadataPending: !closure };
        } catch (metadataError) {
            emitArchive(thread, timestamp);
            return { archived: true, alreadyArchived, requestId, closure: null,
                archiveTimestamp: timestamp, metadataPending: true, metadataError };
        }
    }

    // An existing archive must not acquire a new actor just because a stale button
    // was pressed. Its previous timestamp is recorded without a new close request.
    if (channel.archived === true) return finalize(channel, { alreadyArchived: true });

    await channel.setLocked(true, reason);
    const requestId = repository.beginThreadClosure(escrowId, { actorId, actorName, kind });
    let archivedThread;
    try {
        archivedThread = await channel.setArchived(true, reason);
    } catch (error) {
        // A lost HTTP response can occur after Discord already archived the thread.
        // Preserve that success when a fresh SDK observation confirms it.
        const observed = await observeThread(channel);
        if (observed?.archived === true) return finalize(observed, { requestId });
        try { repository.failThreadClosure(requestId); }
        catch (metadataError) {
            console.warn('[CLOSE] Could not mark an unsuccessful close request:', metadataError.message);
        }
        throw error;
    }
    return finalize(archivedThread || channel, { requestId });
}

module.exports = { closeDealThread };
