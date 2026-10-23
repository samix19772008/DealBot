const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { listEscrowsForUser } = require('../../database/escrowRepository');

const PAGE_SIZE = 6;
const displayStatus = status => status.replaceAll('_', ' ');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deals')
        .setDescription('Privately list your escrow deals in this server')
        .setDMPermission(false)
        .addStringOption(option => option
            .setName('status').setDescription('Show active deals or your full history')
            .addChoices({ name: 'Active deals', value: 'active' }, { name: 'All deals', value: 'all' }))
        .addIntegerOption(option => option
            .setName('page').setDescription('Page number').setMinValue(1).setMaxValue(1000)),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Use this command inside your escrow server.', ephemeral: true });
        }
        const page = interaction.options.getInteger('page') ?? 1;
        const status = interaction.options.getString('status') ?? 'active';
        if (!Number.isInteger(page) || page < 1 || page > 1000 || !['active', 'all'].includes(status)) {
            return interaction.reply({ content: 'Choose a page between 1 and 1000 and a valid status filter.', ephemeral: true });
        }
        const deals = listEscrowsForUser(interaction.guildId, interaction.user.id, {
            status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
        });
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(status === 'active' ? 'Your Active Deals' : 'Your Deal History')
            .setDescription(deals.length
                ? 'Only your deals in this server are shown. Use `/deal-status` with a reference below to view its timeline.'
                : `No ${status === 'active' ? 'active ' : ''}deals found on this page.${page > 1 ? ' Try a previous page.' : ' Start one with /deal.'}`)
            .setFooter({ text: `DealBot • Page ${page}${deals.length === PAGE_SIZE ? ` • Use /deals page:${page + 1} for the next page` : ''}` })
            .setTimestamp();
        for (const deal of deals) {
            const otherId = deal.buyer_discord_id === interaction.user.id ? deal.seller_discord_id : deal.buyer_discord_id;
            const item = escapeMarkdown(String(deal.item_description).slice(0, 160));
            const amount = Number(deal.amount).toLocaleString('en-US', { maximumFractionDigits: 2 });
            const thread = deal.channel_id ? `\n[Open conversation](https://discord.com/channels/${interaction.guildId}/${deal.channel_id})` : '';
            embed.addFields({
                name: deal.transaction_uuid,
                value: `**${displayStatus(deal.status)}** · ${amount} ${escapeMarkdown(deal.currency)}\nWith <@${otherId}>\n${item}${thread}`,
            });
        }
        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    },
};
