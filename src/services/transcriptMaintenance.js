const { processTranscriptQueue, stopTranscriptService } = require('./transcripts');

/** Explicitly started only after login; imports never start a timer or send a DM. */
function startTranscriptMaintenance({
    client,
    intervalMs = 60_000,
    processQueue = processTranscriptQueue,
    stopWorker = stopTranscriptService,
    schedule = setInterval,
    cancel = clearInterval,
    onError = error => console.warn('[TRANSCRIPT] Queue maintenance failed:', error.code ?? error.name),
} = {}) {
    if (!client || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 ||
        typeof processQueue !== 'function' || typeof stopWorker !== 'function') {
        throw new Error('A client, queue worker, and positive maintenance interval are required.');
    }
    let stopped = false;
    let stopTask = null;
    let active = null;
    const run = () => {
        if (stopped || active) return active;
        active = Promise.resolve().then(() => processQueue(client))
            .catch(error => { onError(error); })
            .finally(() => { active = null; });
        return active;
    };
    run();
    const timer = schedule(run, intervalMs);
    timer.unref?.();
    return () => {
        if (stopTask) return stopTask;
        stopped = true;
        cancel(timer);
        // Pause event-triggered work as well as the timer before draining it.
        stopTask = Promise.all([active, Promise.resolve().then(stopWorker)]).then(() => undefined);
        return stopTask;
    };
}

module.exports = { startTranscriptMaintenance };
