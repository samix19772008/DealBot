const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const { buildDealEmbed } = require('./embedTemplate');
const { getOrCreateUser } = require('../database/userRepository');
const { createEscrow, cancelEscrow } = require('../database/escrowRepository');
const { getGuildSettings } = require('../database/guildSettingsRepository');
const { getGuildReputation } = require('../database/reputationRepository');
const { acquireOfferCooldown, expirePendingOffers, assertActiveDealLimit } = require('../database/offerPolicyRepository');
const { validateDealInput } = require('./validation');
const { t } = require('./i18n');
const { resolvePayment, formatPayment } = require('./payments');
const { getListingQuote } = require('../database/listingRepository');
const { listingFingerprint } = require('./listings');
const { getAccessibleSourceMessage } = require('./sourceMessage');

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

async function sendDealOffer({ interaction, sellerDiscordUser, itemDescription, amount, currency = 'USD', paymentUnit = 'each', allowPublicOffer = false, listingRequest }) {
    if (!interaction.guildId || !interaction.guild) {
        return respond(interaction, { content: 'Start a deal from inside your server.' });
    }
    if (sellerDiscordUser.id === interaction.user.id) {
        return respond(interaction, { content: t('deal.cannotDealSelf', 'en') });
    }
    if (sellerDiscordUser.bot) return respond(interaction, { content: t('deal.cannotDealBot', 'en') });

    let details;
    let listingQuote;
    try {
        if (listingRequest) {
            listingQuote = getListingQuote(listingRequest.token, {
                guildId: interaction.guildId, buyerDiscordId: interaction.user.id,
                methodKey: listingRequest.methodKey, quantity: listingRequest.quantity,
            });
            if (listingQuote.session.seller_discord_id !== sellerDiscordUser.id) {
                return respond(interaction, { content: 'The listing seller has changed. Reopen Request a Deal on the source message.' });
            }
            // Prices and descriptions come only from the stored seller listing.
            ({ itemDescription } = listingQuote);
            ({ amount, currency, paymentUnit } = listingQuote.payment);
        }
        const payment = resolvePayment({ method: currency, amount, unit: paymentUnit });
        details = { ...validateDealInput({ itemDescription, ...payment }), paymentUnit: payment.paymentUnit };
    }
    catch (error) { return respond(interaction, { content: error.message }); }

    expirePendingOffers({ guildId: interaction.guildId });
    const buyer = getOrCreateUser(interaction.user);
    const seller = getOrCreateUser(sellerDiscordUser);
    const buyerReputation = getGuildReputation(interaction.guildId, buyer.id);
    const sellerReputation = getGuildReputation(interaction.guildId, seller.id);
    if (buyerReputation.is_scammer || sellerReputation.is_scammer) {
        return respond(interaction, { content: 'A participant is flagged as a scammer in this server. A new deal cannot be opened.' });
    }
    const settings = getGuildSettings(interaction.guildId);
    if (!settings?.hub_channel_id) {
        return respond(interaction, { content: t('errors.hubNotConfigured', 'en') });
    }
    try { assertActiveDealLimit(interaction.guildId, buyer.id); }
    catch (error) {
        if (error.code === 'ACTIVE_DEAL_LIMIT') return respond(interaction, { content: error.message });
        throw error;
    }

    const cooldown = acquireOfferCooldown(interaction.guildId, interaction.user.id);
    if (!cooldown.allowed) {
        return respond(interaction, { content: `Please wait ${Math.ceil(cooldown.retryAfterMs / 1000)} seconds before sending another deal request.` });
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

    if (listingQuote) {
        const session = listingQuote.session;
        const source = await getAccessibleSourceMessage(interaction, session.channel_id, session.message_id);
        if (source.error) return respond(interaction, { content: source.error, allowedMentions: { parse: [] } });
        if (source.message.author.id !== session.seller_discord_id || listingFingerprint(source.message) !== session.source_fingerprint) {
            return respond(interaction, { content: 'The seller edited this listing. Reopen Request a Deal to use its current prices.' });
        }
    }

    let escrow;
    try {
        // The repository repeats the cap check in its insertion transaction: another
        // request may have filled the final slot while Discord lookups were pending.
        escrow = createEscrow({
            guildId: interaction.guildId, buyerId: buyer.id, sellerId: seller.id, ...details, listingRequest,
        });
    } catch (error) {
        if (['ACTIVE_DEAL_LIMIT', 'LISTING_REQUEST_INVALID'].includes(error.code)) {
            return respond(interaction, { content: error.message, allowedMentions: { parse: [] } });
        }
        throw error;
    }
    const embed = buildDealEmbed({
        title: 'New Escrow Request', referenceId: escrow.transaction_uuid, status: 'pending',
        rows: [
            { label: 'Buyer', value: `<@${interaction.user.id}>` },
            { label: 'Seller', value: `<@${sellerDiscordUser.id}>` },
            { label: 'Item', value: details.itemDescription },
            { label: 'Agreed Payment', value: formatPayment(details) },
        ],
        footerNote: 'Unaccepted offers expire after 24 hours. DealBot does not hold or verify funds.',
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
        if (allowPublicOffer !== true) {
            cancelEscrow(escrow.id, { actorId: interaction.user.id, reason: 'Seller DMs unavailable; public posting not permitted' });
            return respond(interaction, {
                content: 'The seller could not receive a DM, so this request was cancelled. Ask the seller to enable DMs, or agree together to share the item and payment details in the hub before using `/deal public-offer:true`.',
            });
        }
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
