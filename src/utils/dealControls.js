const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Rebuild controls from persisted state so a failed Discord message or bot
// restart never makes an active deal impossible to continue.
function buildDealControls(escrow, { moderator = false, userId } = {}) {
    const row = new ActionRowBuilder();
    const add = (prefix, label, style) => row.addComponents(new ButtonBuilder()
        .setCustomId(`${prefix}${escrow.id}`).setLabel(label).setStyle(style));
    const participant = !userId || [escrow.buyer_discord_id, escrow.seller_discord_id].includes(userId);
    if (escrow.status === 'pending') {
        if (!userId || userId === escrow.seller_discord_id) add('accept_escrow_', 'Accept Deal', ButtonStyle.Success);
        if (participant) add('cancel_escrow_', 'Cancel Request', ButtonStyle.Danger);
    } else if (['awaiting_payment', 'funded', 'delivered'].includes(escrow.status)) {
        const step = {
            awaiting_payment: ['confirm_payment_', 'Confirm Payment Sent'],
            funded: ['confirm_delivery_', 'Confirm Delivery'],
            delivered: ['confirm_receipt_', 'Confirm Receipt, End Deal'],
        }[escrow.status];
        const actor = escrow.status === 'funded' ? escrow.seller_discord_id : escrow.buyer_discord_id;
        if (!userId || userId === actor) add(...step, ButtonStyle.Primary);
        if (participant) add('open_dispute_', 'Open Dispute', ButtonStyle.Danger);
    } else if (escrow.status === 'disputed' && moderator) {
        add('resolve_complete_', 'Complete Deal', ButtonStyle.Success);
        add('resolve_cancel_', 'Cancel Deal', ButtonStyle.Secondary);
        add('resolve_scammer_', 'Flag a Scammer', ButtonStyle.Danger);
    } else if (['completed', 'cancelled', 'refunded'].includes(escrow.status) && escrow.channel_id) {
        if (participant) add('approve_close_', 'Approve Close', ButtonStyle.Secondary);
        if (moderator) add('admin_close_', 'Force Close (Moderator)', ButtonStyle.Danger);
    }
    return row.components.length ? [row] : [];
}

module.exports = { buildDealControls };
