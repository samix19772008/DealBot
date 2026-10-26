const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildStats } = require('../../database/reputationRepository');

module.exports = {
    registered: false,
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Privately view aggregate escrow activity for this server over the last 30 days')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can view escrow statistics.', ephemeral: true });
        }
        const metrics = getGuildStats(interaction.guildId, { days: 30 });
        const number = value => Number(value).toLocaleString('en-US');
        const completionRate = metrics.completionDenominator
            ? `${(metrics.completionRate * 100).toFixed(1)}% (${number(metrics.completionNumerator)} completed / ${number(metrics.completionDenominator)} opened)`
            : 'No deals were opened in this window.';
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Server Escrow Statistics · Last 30 Days')
            .setDescription('Counts below cover deals opened in this server during the last 30 days, grouped by their current status. The active-deal count includes all creation dates.')
            .addFields(
                { name: 'Deals Opened', value: number(metrics.created), inline: true },
                { name: 'Currently Completed', value: number(metrics.completed), inline: true },
                { name: 'Currently Disputed', value: number(metrics.disputed), inline: true },
                { name: 'Currently Cancelled', value: number(metrics.cancelled), inline: true },
                { name: 'Currently Refunded', value: number(metrics.refunded), inline: true },
                { name: 'Unique Traders', value: `${number(metrics.uniqueTraders)} participants in the last 30 days' opened deals`, inline: true },
                { name: 'Completion Rate', value: completionRate },
                { name: 'All Current Active Deals', value: `${number(metrics.activeCount)} pending, awaiting payment, funded, delivered, or disputed deals, across all dates.` },
                { name: 'Scope and Privacy', value: 'This server only. These are aggregate counts; no participant names, deal details, or combined payment totals are shown.' },
            )
            .setFooter({ text: 'DealBot • Private administrator overview • Completion rate = completed / opened in this window' })
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    },
};
