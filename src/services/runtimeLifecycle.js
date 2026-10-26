/** Stop accepting new work, drain handlers and workers, then close SQLite. */
function createShutdown({ client, stopEarly = [], drain = async () => {}, stopLate = [], closeDatabase,
    timeoutMs = 25_000, forceExit = code => process.exit(code), schedule = setTimeout, cancel = clearTimeout,
    logger = console } = {}) {
    if (!client || typeof closeDatabase !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Shutdown requires a client, database closer, and positive deadline.');
    }
    let pending;
    return () => {
        if (pending) return pending;
        client.dealBotStopping = true;
        pending = Promise.resolve().then(async () => {
            let timedOut = false;
            const failures = [];
            const timer = schedule(() => {
                timedOut = true;
                logger.error('[SHUTDOWN] Graceful shutdown exceeded its deadline; committed SQLite data remains on disk.');
                // Do not close a database underneath work that is still active.
                forceExit(1);
            }, timeoutMs);
            timer.unref?.();
            async function safely(action) {
                try { await action(); }
                catch (error) {
                    failures.push(error);
                    logger.error('[SHUTDOWN] A service could not stop cleanly:', error.code ?? error.name);
                }
            }
            try {
                for (const stop of stopEarly) await safely(stop);
                await safely(drain);
                await Promise.all(stopLate.map(stop => safely(stop)));
                if (!timedOut && !failures.length) {
                    await safely(() => client.destroy());
                    if (!failures.length) await safely(closeDatabase);
                }
                if (!timedOut && failures.length) forceExit(1);
                return { timedOut, failed: failures.length > 0 };
            } finally {
                cancel(timer);
            }
        });
        return pending;
    };
}

module.exports = { createShutdown };
