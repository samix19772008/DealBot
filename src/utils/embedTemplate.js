const { EmbedBuilder } = require('discord.js');
const { boundedText } = require('./validation');

const COLORS = { pending: 0xFEE75C, success: 0x23A55A, danger: 0xED4245, info: 0x5865F2, banned: 0x2B2D31 };
const STATUS_ICONS = { pending: '⏳', success: '✅', danger: '❌', info: 'ℹ️', banned: '🚫' };

function buildDealEmbed({ title, referenceId, rows = [], status = 'info', footerNote }) {
    const embed = new EmbedBuilder()
        .setColor(COLORS[status] ?? COLORS.info)
        .setTitle(boundedText(`${STATUS_ICONS[status] ?? STATUS_ICONS.info} ${title}`, 256))
        .setTimestamp();
    if (referenceId) embed.setDescription(`\`${boundedText(referenceId, 80)}\``);
    // Respect both individual field limits and Discord's total embed limit.
    let remaining = 4500;
    for (const row of rows.slice(0, 25)) {
        const name = boundedText(row.label, Math.min(256, remaining));
        remaining -= name.length;
        if (remaining < 2) break;
        const value = boundedText(row.value, Math.min(1024, remaining));
        embed.addFields({ name, value, inline: Boolean(row.inline) });
        remaining -= value.length;
        if (remaining < 2) break;
    }
    embed.setFooter({ text: boundedText(footerNote ? `DealBot • ${footerNote}` : 'DealBot', 512) });
    return embed;
}

module.exports = { buildDealEmbed, COLORS, STATUS_ICONS };
