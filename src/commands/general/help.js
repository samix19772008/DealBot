const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Learn how escrow requests, private deals, and disputes work')
        .setDMPermission(false),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('DealBot Help')
            .setDescription('Manage a deal in a private thread, follow each confirmation step, and involve server staff when a dispute needs review.')
            .addFields(
                { name: 'Start a Deal', value: '`/deal seller:@seller item:description price:25.50 USD`\nYou can also right-click a seller\'s message → Apps → Request a Deal. The seller accepts or declines the request.' },
                { name: 'Follow the Steps', value: '1. Buyer confirms payment was sent.\n2. Seller verifies payment independently, delivers, and confirms delivery.\n3. Buyer checks the item or service and confirms receipt.\nA completed deal awards each participant 5 trust points once.' },
                { name: 'Track Your Deals', value: '`/deals` — Your active deals, privately.\n`/deals status:all` — Your deal history in this server.\n`/deal-status reference:ESC-…` — Deal details and recorded activity.\n`/profile user:@member` — A user\'s trust record and rank.' },
                { name: 'Disputes and Closing', value: 'Use **Open Dispute** in an active deal to explain the problem to staff. Only authorized staff can resolve it. After resolution, both participants can approve closing the thread, or staff can close it. Archived conversations are sent to participants as HTML transcripts when their DMs are open.' },
                { name: 'Administrator Setup', value: '`/set-hub-channel` — A regular text channel for private threads.\n`/set-mod-role` — Staff authorized to review disputes.\n`/set-rank-role` — Optional cosmetic roles for trust ranks.\n`/set-rank` — Manually set trust points to a rank threshold.\n`/set-language` — English is the bot\'s language.' },
                { name: 'How Payments Work', value: 'DealBot tracks confirmations and conversations. It does not hold funds, send refunds, or independently verify a payment. Participants must check the payment and delivery themselves.' },
            )
            .setFooter({ text: 'DealBot • English throughout • /ping checks latency' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    },
};
