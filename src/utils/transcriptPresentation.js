const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { boundedText } = require('./validation');
const { formatPayment } = require('./payments');

const TRANSCRIPT_COLOR = 0x8B5CF6;
const STATUS_LABELS = {
    pending: 'Pending', awaiting_payment: 'Waiting for payment', funded: 'Payment reported',
    delivered: 'Delivery reported', completed: 'Completed', disputed: 'Disputed',
    cancelled: 'Cancelled', refunded: 'Refunded',
};

function detail(value) {
    // User-written names/descriptions must not be able to close a field's code block.
    return `\`\`\`\n${boundedText(value, 1000).replace(/`/g, 'ˋ')}\n\`\`\``;
}

function avatar(user) {
    return typeof user?.displayAvatarURL === 'function'
        ? user.displayAvatarURL({ size: 256 }) : undefined;
}

function transcriptFilename(escrow) {
    const item = String(escrow.item_description).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'deal';
    return `transcript-${item}-${escrow.id}.html`;
}

function buildTranscriptSummary({ escrow, closure, guild, clientUser, closerUser, hasTranscript = true }) {
    const timestamp = closure.archive_timestamp;
    const seconds = Math.floor(timestamp / 1000);
    const guildIcon = typeof guild?.iconURL === 'function' ? guild.iconURL({ size: 256 }) : null;
    const logo = guildIcon || avatar(clientUser);
    const author = { name: boundedText(guild?.name || 'DealBot', 256) };
    if (logo) author.iconURL = logo;
    const firstLine = String(escrow.item_description).split(/\r?\n/).find(line => line.trim()) || 'Deal';
    const itemTitle = firstLine.replace(/[*_~`>#|]/g, '').replace(/\s+/g, ' ').trim() || 'Deal';
    const knownCloser = closure.actor_discord_id && closure.kind !== 'untracked';
    const closedBy = knownCloser
        ? `${closure.actor_name || closure.actor_discord_id} : ${closure.actor_discord_id}`
        : 'Automatic archive or a Discord-side action';
    const status = STATUS_LABELS[escrow.status] || String(escrow.status).replaceAll('_', ' ');
    const footer = { text: boundedText(`${closure.actor_name || 'DealBot'} • ${status}`, 256) };
    const closerAvatar = avatar(closerUser);
    if (closerAvatar) footer.iconURL = closerAvatar;

    const embed = new EmbedBuilder()
        .setColor(TRANSCRIPT_COLOR)
        .setAuthor(author)
        .setTitle(boundedText(`Deal Transcript — ${itemTitle}`, 160))
        .addFields(
            { name: 'Deal', value: detail(escrow.item_description) },
            { name: 'Reference', value: detail(escrow.transaction_uuid) },
            { name: 'Created By', value: detail(`${escrow.buyer_username} : ${escrow.buyer_discord_id}`) },
            { name: 'Seller', value: detail(`${escrow.seller_username} : ${escrow.seller_discord_id}`) },
            { name: 'Payment', value: detail(formatPayment(escrow)) },
            { name: 'Closed By', value: detail(closedBy) },
            { name: 'Closed At', value: `<t:${seconds}:F>` },
        )
        .setFooter(footer)
        .setTimestamp(timestamp);
    if (logo) embed.setThumbnail(logo);
    if (!hasTranscript) {
        embed.addFields({ name: 'Transcript', value: 'The conversation file could not be generated. Your deal summary is preserved here.' });
    }
    const components = escrow.channel_id ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View Deal')
            .setURL(`https://discord.com/channels/${escrow.guild_id}/${escrow.channel_id}`),
    )] : [];
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

module.exports = { buildTranscriptSummary, transcriptFilename, TRANSCRIPT_COLOR };
