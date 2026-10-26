const { Events, PermissionFlagsBits } = require('discord.js');
const { getEscrowById } = require('../database/escrowRepository');
const { expirePendingOffers } = require('../database/offerPolicyRepository');

const processingDeals = new Set();
const DM_ACTIONS = new Set(['accept_escrow_', 'cancel_escrow_', 'cancel_reason_modal_']);

async function report(interaction, content) {
    const payload = { content, ephemeral: true, allowedMentions: { parse: [] } };
    if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
    return interaction.reply(payload);
}

function getActionEscrowId(interaction, handler) {
    if (['deal_offer_modal_', 'deal_payment_method_', 'deal_product_', 'listing_preview_'].includes(handler.id)) return null;
    const value = interaction.customId.slice(handler.id.length);
    const match = handler.id === 'scammer_pick_' ? value.match(/^(?:buyer|seller)_(\d+)$/) : value.match(/^(\d+)$/);
    return match?.[1] ?? false;
}

async function executeAction(interaction, handler) {
    const escrowId = getActionEscrowId(interaction, handler);
    if (escrowId === false) return report(interaction, 'This action is invalid. Open the current deal controls and try again.');
    if (escrowId === null) {
        if (!interaction.guildId) return report(interaction, 'Use this action inside your server.');
        return handler.execute(interaction, interaction.client);
    }
    let escrow = getEscrowById(escrowId);
    if (!escrow) return report(interaction, 'This deal no longer exists.');
    if (interaction.guildId && interaction.guildId !== escrow.guild_id) {
        return report(interaction, 'This deal belongs to a different server.');
    }
    if (escrow.status === 'pending') {
        expirePendingOffers({ guildId: escrow.guild_id });
        escrow = getEscrowById(escrowId);
    }
    if (!escrow.channel_id && ['cancelled', 'refunded', 'completed'].includes(escrow.status)) {
        return report(interaction, 'This request has ended or expired. Use /deal to start a new request.');
    }
    const isPendingOfferAction = DM_ACTIONS.has(handler.id) && escrow.status === 'pending';
    if (!interaction.guildId && !isPendingOfferAction) {
        return report(interaction, 'Use the current controls inside the deal thread.');
    }
    if (!isPendingOfferAction && (!escrow.channel_id || interaction.channelId !== escrow.channel_id)) {
        return report(interaction, 'Use this action inside its original deal thread.');
    }
    const key = String(escrow.id);
    if (processingDeals.has(key)) return report(interaction, 'Another action is processing for this deal. Please try again in a moment.');
    processingDeals.add(key);
    try { await handler.execute(interaction, interaction.client); }
    finally { processingDeals.delete(key); }
}

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction, client) {
        try {
            if (client.dealBotStopping) {
                return await report(interaction, 'DealBot is restarting. Please try again in a moment; your saved deals are kept.');
            }
            if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {
                const command = client.commands.get(interaction.commandName);
                if (!command) return report(interaction, 'This command is no longer available. Ask an administrator to refresh the bot commands.');
                if (!interaction.guildId) return report(interaction, 'Use this command inside your server.');
                const data = command.data.toJSON();
                if (data.default_member_permissions &&
                    !interaction.memberPermissions?.has(BigInt(data.default_member_permissions))) {
                    return report(interaction, 'You do not have permission to use this command.');
                }
                return await command.execute(interaction, client);
            }
            if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu?.()) {
                const handlers = (interaction.isButton() ? client.buttons
                    : interaction.isStringSelectMenu?.() ? client.selects : client.modals) ?? [];
                const handler = handlers.find(entry => interaction.customId.startsWith(entry.id));
                if (!handler) return report(interaction, 'These controls are no longer available. Use /deal-status to view the current deal.');
                return await executeAction(interaction, handler);
            }
        } catch (error) {
            console.error('[INTERACTION] Action failed:', error.code ?? error.name ?? 'Unknown error');
            try { await report(interaction, 'This action could not be completed. Check /deal-status before trying again.'); }
            catch (replyError) { console.warn('[INTERACTION] Could not send the error response:', replyError.code ?? replyError.name); }
        }
    },
    getActionEscrowId,
    processingDeals,
};
