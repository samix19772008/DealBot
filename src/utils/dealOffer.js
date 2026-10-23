const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const { buildDealEmbed } = require('./embedTemplate');
const { getOrCreateUser } = require('../database/userRepository');
const { createEscrow, cancelEscrow, listEscrowsForUser } = require('../database/escrowRepository');
const { getGuildSettings } = require('../database/guildSettingsRepository');
const { validateDealInput } = require('./validation');
const { t } = require('./i18n');

const offerCooldowns = new Map();
const REQUIRED_HUB_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
];

async function respond(interaction, payload) {
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.reply({ ...payload, ephemeral: true });
}

async function sendDealOffer({ interaction, sellerDiscordUser, itemDescription, amount, currency = 'USD' }) {
    if (!interaction.guildId || !interaction.guild) {
        return respond(interaction, { content: 'Start a deal from inside your server.' });
    }
    if (sellerDiscordUser.id === interaction.user.id) {
        return respond(interaction, { content: t('deal.cannotDealSelf', 'en') });
    }
    if (sellerDiscordUser.bot) return respond(interaction, { content: t('deal.cannotDealBot', 'en') });

    let details;
    try { details = validateDealInput({ itemDescription, amount, currency }); }
    catch (error) { return respond(interaction, { content: error.message }); }

    const buyer = getOrCreateUser(interaction.user);
    const seller = getOrCreateUser(sellerDiscordUser);
    if (buyer.is_scammer || seller.is_scammer) {
        return respond(interaction, { content: 'A participant is flagged as a scammer. A new deal cannot be opened.' });
    }
    const settings = getGuildSettings(interaction.guildId);
    if (!settings?.hub_channel_id) {
        return respond(interaction, { content: t('errors.hubNotConfigured', 'en') });
    }
    if (listEscrowsForUser(interaction.guildId, interaction.user.id, { limit: 10 }).length >= 10) {
        return respond(interaction, { content: 'You already have 10 active deals. Complete or cancel an existing deal before opening another.' });
    }

    const key = `${interaction.guildId}:${interaction.user.id}`;
    const now = Date.now();
    if (now - (offerCooldowns.get(key) ?? 0) < 15000) {
        return respond(interaction, { content: 'Please wait 15 seconds before sending another deal request.' });
    }
    offerCooldowns.set(key, now);
    // Keep rate-limit memory bounded without an interval that keeps tests alive.
    for (const [entry, timestamp] of offerCooldowns) {
        if (now - timestamp >= 15000) offerCooldowns.delete(entry);
    }

    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    const [sellerMember, hub, bot] = await Promise.all([
        guild.members.fetch(sellerDiscordUser.id).catch(() => null),
        guild.channels.fetch(settings.hub_channel_id).catch(() => null),
        guild.members.fetchMe().catch(() => null),
    ]);
    if (!sellerMember) return respond(interaction, { content: 'The seller must be a member of this server.' });
    if (!hub || hub.type !== ChannelType.GuildText) {
        return respond(interaction, { content: 'The escrow hub is unavailable. Ask an administrator to run /set-hub-channel.' });
    }
    if (!bot || !hub.permissionsFor(bot)?.has(REQUIRED_HUB_PERMISSIONS)) {
        return respond(interaction, { content: 'The bot needs View Channel, Send Messages, Embed Links, Read Message History, Create Private Threads, Send Messages in Threads, and Manage Threads in the escrow hub.' });
    }
    if (!hub.permissionsFor(sellerMember)?.has(PermissionFlagsBits.ViewChannel)) {
        return respond(interaction, { content: 'The seller needs access to the escrow hub before a deal can be opened.' });
    }
    const buyerMember = interaction.member;
    if (buyerMember && !hub.permissionsFor(buyerMember)?.has(PermissionFlagsBits.ViewChannel)) {
        return respond(interaction, { content: 'You need access to the escrow hub before opening a deal.' });
    }

    const escrow = createEscrow({
        guildId: interaction.guildId, buyerId: buyer.id, sellerId: seller.id, ...details,
    });
    const embed = buildDealEmbed({
        title: 'New Escrow Request', referenceId: escrow.transaction_uuid, status: 'pending',
        rows: [
            { label: 'Buyer', value: `<@${interaction.user.id}>` },
            { label: 'Seller', value: `<@${sellerDiscordUser.id}>` },
            { label: 'Item', value: details.itemDescription },
            { label: 'Amount', value: `${details.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${details.currency}` },
        ],
        footerNote: 'Payment is arranged by participants. DealBot does not hold or verify funds.',
    });
    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`accept_escrow_${escrow.id}`).setLabel('Accept Deal').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`cancel_escrow_${escrow.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌'),
    );
    try {
        await sellerDiscordUser.send({
            content: `You have a deal request from <@${interaction.user.id}> in **${guild.name}**.`,
            embeds: [embed], components: [buttons], allowedMentions: { parse: [] },
        });
    } catch {
        try {
            const message = await hub.send({
                content: `<@${sellerDiscordUser.id}>, a deal request is waiting for your response. Your DMs are closed.`,
                embeds: [embed], components: [buttons],
                allowedMentions: { parse: [], users: [sellerDiscordUser.id] },
            });
            return respond(interaction, { content: `The seller could not receive a DM. The request was posted in the escrow hub: ${message.url}` });
        } catch (error) {
            cancelEscrow(escrow.id, { actorId: interaction.user.id, reason: 'Offer delivery failed.' });
            console.warn('[DEAL] Offer delivery failed:', error.code ?? error.name);
            return respond(interaction, { content: 'The request could not be delivered and was cancelled. Ask the seller to enable DMs or an administrator to check the hub permissions.' });
        }
    }
    return respond(interaction, { content: `✅ Request \`${escrow.transaction_uuid}\` was sent to <@${sellerDiscordUser.id}> via DM. Use /deals to track its status.` });
}

module.exports = { sendDealOffer, REQUIRED_HUB_PERMISSIONS };
