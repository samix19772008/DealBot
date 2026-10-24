const { expirePendingOffers } = require('../database/offerPolicyRepository');

/** Start only for a live bot session. Importing commands never creates a timer. */
function startOfferMaintenance({
    intervalMs = 60_000,
    expire = expirePendingOffers,
    schedule = setInterval,
    cancel = clearInterval,
    onError = error => console.warn('[OFFERS] Pending-offer expiry failed:', error.code ?? error.name),
} = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new Error('The offer-maintenance interval must be a positive integer.');
    }
    let stopped = false;
    const run = () => {
        if (stopped) return;
        try { expire(); }
        catch (error) { onError(error); }
    };
    run();
    const timer = schedule(run, intervalMs);
    timer.unref?.();
    return () => {
        if (stopped) return;
        stopped = true;
        cancel(timer);
    };
}

module.exports = { startOfferMaintenance };
