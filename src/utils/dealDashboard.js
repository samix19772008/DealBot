const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const { listEscrowsForUser, countEscrowsForUser } = require('../database/escrowRepository');
const { expirePendingOffers } = require('../database/offerPolicyRepository');
const { formatPayment } = require('./payments');

const DASHBOARD_PAGE_SIZE = 6;
const MAX_DASHBOARD_PAGE = 1000;
const DASHBOARD_FILTERS = Object.freeze([
    Object.freeze({ key: 'active', label: 'Active deals', title: 'Your Active Deals' }),
    Object.freeze({ key: 'attention', label: 'Needs your action', title: 'Deals Waiting for You' }),
    Object.freeze({ key: 'completed', label: 'Completed deals', title: 'Your Completed Deals' }),
    Object.freeze({ key: 'all', label: 'All deals', title: 'Your Deal History' }),
]);
const FILTER_KEYS = new Set(DASHBOARD_FILTERS.map(filter => filter.key));

function invalid(message = 'Choose a page between 1 and 1000 and a valid status filter.') {
    const error = new Error(message);
    error.code = 'DASHBOARD_INPUT_INVALID';
    return error;
}

function validateDashboard({ guildId, userId, status, page }) {
    if (![guildId, userId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value)) ||
        !FILTER_KEYS.has(status) || !Number.isInteger(page) || page < 1 || page > MAX_DASHBOARD_PAGE) throw invalid();
}

function parseDashboardControl(interaction, prefix, { action = false } = {}) {
    if (typeof interaction.customId !== 'string' || !interaction.customId.startsWith(prefix)) throw invalid('Open /deals again to refresh this dashboard.');
    const parts = interaction.customId.slice(prefix.length).split(':');
    if (parts.length !== (action ? 5 : 4) || !/^[1-9]\d{0,3}$/.test(parts[3])) throw invalid('Open /deals again to refresh this dashboard.');
    const [guildId, userId, status, rawPage, operation] = parts;
    const result = { guildId, userId, status, page: Number(rawPage) };
    validateDashboard(result);
    if (!interaction.guildId || interaction.guildId !== guildId || interaction.user.id !== userId) {
        throw invalid('This dashboard belongs to another user or server. Open /deals for your own deals.');
    }
    if (action && !['prev', 'next', 'refresh'].includes(operation)) throw invalid('Open /deals again to refresh this dashboard.');
    return { ...result, operation };
}

function dealNumber(deal) { return `#${String(deal.id).padStart(4, '0')}`; }
function itemTitle(deal) { return String(deal.item_description ?? '').split(/\r?\n/, 1)[0].trim().slice(0, 120) || 'Item or service'; }
function nextStep(deal, userId) {
    if (deal.status === 'pending') return deal.seller_discord_id === userId ? 'Your turn · Review request' : 'Waiting for seller';
    if (deal.status === 'awaiting_payment') return deal.buyer_discord_id === userId ? 'Your turn · Confirm payment sent' : 'Waiting for buyer payment';
    if (deal.status === 'funded') return deal.seller_discord_id === userId ? 'Your turn · Confirm delivery' : 'Waiting for seller delivery';
    if (deal.status === 'delivered') return deal.buyer_discord_id === userId ? 'Your turn · Confirm receipt' : 'Waiting for buyer receipt';
    if (deal.status === 'disputed') return 'Waiting for staff review';
    return String(deal.status).replaceAll('_', ' ');
}

function buildDealDashboard({ guildId, userId, status = 'active', page = 1 }) {
    validateDashboard({ guildId, userId, status, page });
    expirePendingOffers({ guildId });
    const counts = Object.fromEntries(DASHBOARD_FILTERS.map(filter => [filter.key,
        countEscrowsForUser(guildId, userId, { status: filter.key })]));
    const total = counts[status];
    const pages = Math.max(1, Math.min(MAX_DASHBOARD_PAGE, Math.ceil(total / DASHBOARD_PAGE_SIZE)));
    const current = Math.min(page, pages);
    const deals = listEscrowsForUser(guildId, userId, { status, limit: DASHBOARD_PAGE_SIZE,
        offset: (current - 1) * DASHBOARD_PAGE_SIZE });
    const filter = DASHBOARD_FILTERS.find(candidate => candidate.key === status);
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(filter.title)
        .setDescription(`**Active:** ${counts.active} · **Needs your action:** ${counts.attention} · **Completed:** ${counts.completed} · **Total:** ${counts.all}\n` +
            (deals.length ? 'Only your deals in this server are shown. Select one below for its full reference, status, and conversation.'
                : status === 'attention' ? 'No deals are waiting for your action.'
                    : `No ${status === 'active' ? 'active ' : status === 'completed' ? 'completed ' : ''}deals found. Start a request from a market post or use /deal.`))
        .setFooter({ text: `DealBot • Page ${current}/${pages} • ${total} ${total === 1 ? 'deal' : 'deals'} in this view` }).setTimestamp();
    for (const deal of deals) {
        const otherId = deal.buyer_discord_id === userId ? deal.seller_discord_id : deal.buyer_discord_id;
        const thread = deal.channel_id ? `\n[Open conversation](https://discord.com/channels/${guildId}/${deal.channel_id})` : '';
        embed.addFields({ name: `Deal ${dealNumber(deal)} · ${escapeMarkdown(itemTitle(deal))}`.slice(0, 256),
            value: `**${nextStep(deal, userId)}** · ${escapeMarkdown(formatPayment(deal))}\nWith <@${otherId}>${thread}` });
    }
    const bound = `${guildId}:${userId}:${status}:${current}`;
    const filterMenu = new StringSelectMenuBuilder().setCustomId(`deals_filter_${bound}`)
        .setPlaceholder('Choose a deal view').addOptions(DASHBOARD_FILTERS.map(candidate => ({
            label: candidate.label, value: candidate.key, default: candidate.key === status,
        })));
    const components = [new ActionRowBuilder().addComponents(filterMenu)];
    if (deals.length) {
        const pick = new StringSelectMenuBuilder().setCustomId(`deals_pick_${bound}`)
            .setPlaceholder('View a deal or resume its conversation')
            .addOptions(deals.map(deal => ({ label: `Deal ${dealNumber(deal)} · ${itemTitle(deal)}`.slice(0, 100),
                value: String(deal.id), description: `${nextStep(deal, userId)} · ${formatPayment(deal)}`.slice(0, 100) })));
        components.push(new ActionRowBuilder().addComponents(pick));
    }
    const navigation = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`deals_page_${bound}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(current === 1),
        new ButtonBuilder().setCustomId(`deals_page_${bound}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`deals_page_${bound}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(current === pages),
    );
    components.push(navigation);
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

module.exports = { DASHBOARD_PAGE_SIZE, MAX_DASHBOARD_PAGE, DASHBOARD_FILTERS, buildDealDashboard,
    parseDashboardControl, dealNumber, itemTitle, nextStep };
