const { randomUUID } = require('crypto');
const { db } = require('./init');
const { parseAmount } = require('../utils/validation');
const { getGuildReputation, recordCompletedEscrow, recordScamFlag, getEscrowReward } = require('./reputationRepository');
const { expirePendingOffers, assertActiveDealLimit } = require('./offerPolicyRepository');

const TERMINAL_STATUSES = ['completed', 'cancelled', 'refunded'];
const ACTIVE_STATUSES = ['pending', 'awaiting_payment', 'funded', 'delivered', 'disputed'];
const JOINED_ESCROW = `
    SELECT e.*, buyer.discord_id AS buyer_discord_id, buyer.username AS buyer_username,
        seller.discord_id AS seller_discord_id, seller.username AS seller_username
    FROM escrow_transactions e
    JOIN users buyer ON buyer.id = e.buyer_id
    JOIN users seller ON seller.id = e.seller_id
`;
const findEscrow = db.prepare(`${JOINED_ESCROW} WHERE e.id = ? OR e.transaction_uuid = ? COLLATE NOCASE`);
const findByChannel = db.prepare(`${JOINED_ESCROW} WHERE e.channel_id = ?`);
const recordEvent = db.prepare(`
    INSERT INTO escrow_events (escrow_id, event_type, from_status, to_status, actor_discord_id, reason)
    VALUES (@escrowId, @type, @from, @to, @actorId, @reason)
`);

function audit(escrowId, type, from, to, actorId, reason) {
    recordEvent.run({ escrowId, type, from: from ?? null, to: to ?? null,
        actorId: actorId == null ? null : String(actorId), reason: reason || null });
}

function getEscrowById(escrowId) {
    if (!['string', 'number', 'bigint'].includes(typeof escrowId)) return undefined;
    return findEscrow.get(escrowId, String(escrowId).trim());
}

function getEscrowByChannelId(channelId) {
    if (!channelId) return undefined;
    return findByChannel.get(channelId);
}

function validateDeal({ guildId, buyerId, sellerId, itemDescription, amount, currency, paymentUnit }) {
    if (!guildId) throw new Error('A server is required to create a deal.');
    if (!buyerId || !sellerId || String(buyerId) === String(sellerId)) {
        throw new Error('A deal must have two different participants.');
    }
    if (typeof amount !== 'number') throw new Error('The amount must be a number.');
    parseAmount(amount);
    if (typeof itemDescription !== 'string' || !itemDescription.trim() || itemDescription.trim().length > 1000) {
        throw new Error('The item description must contain between 1 and 1,000 characters.');
    }
    if (typeof currency !== 'string' || !currency.trim() || currency.trim().length > 24 || /[\x00-\x1f\x7f<>@`]/.test(currency)) {
        throw new Error('The currency or payment method must contain between 1 and 24 characters.');
    }
    for (const id of [buyerId, sellerId]) {
        const user = db.prepare('SELECT is_scammer FROM users WHERE id = ?').get(id);
        if (!user) throw new Error('Both participants must have a trust profile.');
        if (getGuildReputation(guildId, id).is_scammer) throw new Error('Users flagged as scammers in this server cannot open new deals.');
    }
    if (paymentUnit == null) return { amount, currency, paymentUnit: null };
    if (!['each', 'stacks'].includes(paymentUnit)) throw new Error('The payment unit must be each or stacks.');
    // The market helper returns canonical currency names without converting a
    // nominal stack count into individual items. Legacy deals remain untouched.
    const { resolvePayment } = require('../utils/payments');
    return resolvePayment({ method: currency, amount, unit: paymentUnit });
}

const createDeal = db.transaction(params => {
    expirePendingOffers({ guildId: params.guildId });
    const { amount, currency, paymentUnit } = validateDeal(params);
    assertActiveDealLimit(params.guildId, Number(params.buyerId));
    const { guildId, buyerId, sellerId, itemDescription } = params;
    const result = db.prepare(`
        INSERT INTO escrow_transactions
            (transaction_uuid, guild_id, buyer_id, seller_id, item_description, amount, currency, payment_unit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`ESC-${randomUUID().toUpperCase()}`, guildId, buyerId, sellerId, itemDescription.trim(),
        Math.round(amount * 100) / 100, currency.trim(), paymentUnit);
    const escrow = getEscrowById(result.lastInsertRowid);
    audit(escrow.id, 'created', null, 'pending', escrow.buyer_discord_id);
    return escrow;
});

function createEscrow({ guildId, buyerId, sellerId, itemDescription, amount, currency = 'USD', paymentUnit }) {
    return createDeal.immediate({ guildId, buyerId, sellerId, itemDescription, amount, currency, paymentUnit });
}

/** A compare-and-set and its audit entry commit together or neither commits. */
const changeState = db.transaction((escrowId, expectedStatuses, nextStatus, type, actorId, details = {}) => {
    const escrow = getEscrowById(escrowId);
    if (!escrow || !expectedStatuses.includes(escrow.status)) return false;
    const result = db.prepare(`
        UPDATE escrow_transactions SET status = ?, updated_at = CURRENT_TIMESTAMP,
            channel_id = COALESCE(?, channel_id),
            dispute_reason = CASE WHEN ? = 'disputed' THEN ? ELSE dispute_reason END,
            completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE id = ? AND status = ?
    `).run(nextStatus, details.channelId ?? null, nextStatus, details.reason ?? null,
        nextStatus, escrow.id, escrow.status);
    if (!result.changes) return false;
    audit(escrow.id, type, escrow.status, nextStatus, actorId, details.reason);
    return true;
});

function acceptEscrow(escrowId, threadId, actorId) {
    if (!threadId) throw new Error('A private thread is required to accept a deal.');
    return db.transaction(() => {
        const original = getEscrowById(escrowId);
        if (!original) return false;
        // The offer may cross its acceptance deadline while Discord prepares
        // the private thread. Recheck expiry inside the final write transaction.
        expirePendingOffers({ guildId: original.guild_id });
        const escrow = getEscrowById(original.id);
        if (escrow.status !== 'pending' || [escrow.buyer_id, escrow.seller_id].some(userId => getGuildReputation(escrow.guild_id, userId).is_scammer)) return false;
        return changeState(escrow.id, ['pending'], 'awaiting_payment', 'accepted', actorId, { channelId: threadId });
    }).immediate();
}

function cancelEscrow(escrowId, { expectedStatus = 'pending', actorId, reason } = {}) {
    if (!['pending', 'disputed'].includes(expectedStatus)) return false;
    return changeState.immediate(escrowId, [expectedStatus], 'cancelled', 'cancelled', actorId, { reason });
}

function markAsFunded(escrowId, actorId) {
    return changeState.immediate(escrowId, ['awaiting_payment'], 'funded', 'payment_confirmed', actorId);
}

function markAsDelivered(escrowId, actorId) {
    return changeState.immediate(escrowId, ['funded'], 'delivered', 'delivery_confirmed', actorId);
}

const finishDeal = db.transaction((escrowId, actorId, expectedStatus) => {
    if (!['delivered', 'disputed'].includes(expectedStatus)) return false;
    const escrow = getEscrowById(escrowId);
    if (!escrow || escrow.status !== expectedStatus) return false;
    if (!changeState(escrow.id, [expectedStatus], 'completed', 'completed', actorId)) return false;
    // The server-local ledger awards one eligible pair reward in a rolling
    // 24-hour window. Every completed deal still counts once in local history.
    recordCompletedEscrow(escrow.id);
    return true;
});

function completeEscrow(escrowId, buyerId, sellerId, actorId, expectedStatus = 'delivered') {
    return finishDeal.immediate(escrowId, actorId, expectedStatus);
}

function markAsDisputed(escrowId, reason, actorId) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
        throw new Error('A dispute reason between 1 and 1,000 characters is required.');
    }
    return changeState.immediate(escrowId, ['awaiting_payment', 'funded', 'delivered'],
        'disputed', 'disputed', actorId, { reason: reason.trim() });
}

const resolveScam = db.transaction((escrowId, userId, actorId) => {
    const escrow = getEscrowById(escrowId);
    if (!escrow || escrow.status !== 'disputed' || ![escrow.buyer_id, escrow.seller_id].includes(Number(userId))) return false;
    if (!changeState(escrow.id, ['disputed'], 'cancelled', 'scammer_flagged', actorId,
        { reason: `Flagged participant: ${Number(userId) === escrow.buyer_id ? escrow.buyer_discord_id : escrow.seller_discord_id}` })) return false;
    const eventId = db.prepare("SELECT id FROM escrow_events WHERE escrow_id = ? AND event_type = 'scammer_flagged' ORDER BY id DESC LIMIT 1").get(escrow.id).id;
    recordScamFlag(escrow.id, Number(userId), eventId);
    return true;
});

function flagScammerAndCancel(escrowId, userId, actorId) {
    return resolveScam.immediate(escrowId, userId, actorId);
}

const approveClose = db.transaction((escrowId, side, actorId) => {
    const escrow = getEscrowById(escrowId);
    if (!escrow || !TERMINAL_STATUSES.includes(escrow.status)) return false;
    const column = side === 'buyer' ? 'buyer_close_approved' : 'seller_close_approved';
    if (escrow[column]) return false;
    const changed = db.prepare(`UPDATE escrow_transactions SET ${column} = 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ${column} = 0`).run(escrow.id);
    if (!changed.changes) return false;
    audit(escrow.id, `${side}_close_approved`, escrow.status, escrow.status,
        actorId || escrow[`${side}_discord_id`]);
    return true;
});

function approveBuyerClose(escrowId, actorId) { return approveClose.immediate(escrowId, 'buyer', actorId); }
function approveSellerClose(escrowId, actorId) { return approveClose.immediate(escrowId, 'seller', actorId); }

/** The caller receives only their own deals in the selected server. */
function listEscrowsForUser(guildId, discordId, { status = 'active', limit = 10, offset = 0 } = {}) {
    if (!guildId || !discordId) return [];
    if (!['active', 'all', ...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(status)) return [];
    const statuses = status === 'all' ? [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] :
        status === 'active' ? ACTIVE_STATUSES : [status];
    const safeLimit = Number.isInteger(limit) ? Math.min(25, Math.max(1, limit)) : 10;
    const safeOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0;
    return db.prepare(`${JOINED_ESCROW}
        WHERE e.guild_id = ? AND (buyer.discord_id = ? OR seller.discord_id = ?)
            AND e.status IN (${statuses.map(() => '?').join(',')})
        ORDER BY e.id DESC LIMIT ? OFFSET ?
    `).all(guildId, discordId, discordId, ...statuses, safeLimit, safeOffset);
}

function getEscrowEvents(escrowId, limit = 10) {
    const escrow = getEscrowById(escrowId);
    if (!escrow) return [];
    const safeLimit = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 10;
    return db.prepare('SELECT * FROM escrow_events WHERE escrow_id = ? ORDER BY id DESC LIMIT ?').all(escrow.id, safeLimit);
}

module.exports = {
    createEscrow, getEscrowById, getEscrowByChannelId, acceptEscrow, cancelEscrow,
    markAsFunded, markAsDelivered, completeEscrow, markAsDisputed, flagScammerAndCancel,
    approveBuyerClose, approveSellerClose, listEscrowsForUser, getEscrowEvents, getEscrowReward,
};
