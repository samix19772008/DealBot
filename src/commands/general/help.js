const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Learn how to buy market listings and track a private escrow deal')
        .setDMPermission(false),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('DealBot Help')
            .setDescription('Agree on the item and one payment option with the seller, then track your deal in a private thread.')
            .addFields(
                { name: 'Easiest: Start from a Market Post', value: 'Right-click the seller\'s listing → **Apps → Request a Deal**. Choose **Money**, **Golds**, **Redblocks**, or **Sky 1 Notchs**, then enter the total agreed payment. The seller accepts or declines your request.' },
                { name: 'Or Use /deal · Choose One Option', value: '`/deal seller:@seller item:Menace Cape payment:Money amount:2`\n`/deal seller:@seller item:Menace Cape payment:Golds amount:45`\n`/deal seller:@seller item:Menace Cape payment:Redblocks amount:20 unit:Stacks`\n`/deal seller:@seller item:Menace Cape payment:Sky 1 Notchs amount:20`\nThese show separate example offers, not currency exchange rates.' },
                { name: 'Amounts and Stacks', value: '**Amount is the total agreed payment, not the quantity of the item you are buying.** Money uses US dollars with up to two decimals. Game payments use whole items or stacks; **1 stack = 64 items**. For example, 20 stacks of Redblocks means 1,280 blocks. Use one payment method per deal; there is no automatic conversion.' },
                { name: 'Follow the Steps', value: '1. Buyer confirms payment was sent.\n2. Seller verifies payment independently, delivers, and confirms delivery.\n3. Buyer checks the item or service and confirms receipt.\nA completed deal awards each participant 5 trust points once.' },
                { name: 'Track Your Deals', value: '`/deals` — Your active deals, privately.\n`/deals status:all` — Your deal history in this server.\n`/deal-status reference:ESC-…` — Details, activity, and restored controls inside the deal thread.\n`/profile user:@member` — A user\'s trust record and rank.' },
                { name: 'Disputes and Closing', value: 'Use **Open Dispute** in an active deal to explain the problem to staff. Only authorized staff can resolve it. After resolution, both participants can approve closing the thread, or staff can close it. Archived conversations are sent to participants as HTML transcripts when their DMs are open.' },
                { name: 'Administrator Setup', value: '`/set-hub-channel` — A regular text channel for private threads.\n`/set-mod-role` — Staff authorized to review disputes.\n`/set-rank-role` — Optional cosmetic roles for trust ranks.\n`/set-rank` — Manually set trust points to a rank threshold.\n`/set-language` — English is the bot\'s language.' },
                { name: 'How Payments Work', value: 'DealBot tracks confirmations and conversations. It does not hold funds, send refunds, or independently verify a payment. Participants must check the payment and delivery themselves.' },
            )
            .setFooter({ text: 'DealBot • English throughout • /ping checks latency' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    },
};
