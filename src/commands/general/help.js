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
            .setDescription('Choose a seller\'s listed payment option and product quantity, then track your deal in a private thread.')
            .addFields(
                { name: 'Easiest: Start from a Market Post', value: 'Right-click the seller\'s listing → **Apps → Request a Deal**. Choose one payment method present in that post, then enter a product quantity from **1 to 999**. The total is calculated from the seller\'s fixed price; buyers cannot edit it. The seller accepts or declines.' },
                { name: 'Sellers: /listing-format', value: 'Copy the listing template, enter prices for one product, and remove payment methods you do not accept. For example, `Item: Menace Cape` followed by `Golds: 33` offers only Golds; quantity 2 costs 66 Golds. Post edits require reopening a picker; created requests keep their terms.' },
                { name: 'Or Use /deal · Choose One Option', value: '`/deal seller:@seller item:Menace Cape payment:Money amount:2`\n`/deal seller:@seller item:Menace Cape payment:Golds amount:45`\n`/deal seller:@seller item:Menace Cape payment:Redblocks amount:20 unit:Stacks`\n`/deal seller:@seller item:Menace Cape payment:Sky 1 Notchs amount:20`\nThese show separate example offers, not currency exchange rates.' },
                { name: 'Offer Privacy', value: 'Offers go to the seller by DM. If their DMs are closed, the request is cancelled without posting its details in the hub. If you agree to share the item and payment details there, explicitly use `/deal public-offer:true`. Requests opened from a market post keep the private default.' },
                { name: 'Amounts and Stacks', value: 'In **Request a Deal**, enter product quantity; the post determines the total. In the separate negotiated **/deal** flow, `amount` is the total agreed payment, and post prices are not enforced. Money uses USD with up to two decimals. Game payments use whole items or stacks; **1 stack = 64 items**. There is no automatic conversion.' },
                { name: 'Follow the Steps', value: '1. Buyer confirms payment was sent.\n2. Seller verifies payment independently, delivers, and confirms delivery.\n3. Buyer checks the item or service and confirms receipt.\nA completed deal adds one successful deal to each participant\'s record in this server.' },
                { name: 'Track Your Deals', value: '`/deals` — Your active deals, privately.\n`/deals status:all` — Your deal history in this server.\n`/deal-status reference:ESC-…` — Details, activity, and restored controls inside the deal thread.\n`/profile user:@member` — A user\'s trust record and rank in this server.' },
                { name: 'Disputes and Closing', value: 'Use **Open Dispute** in an active deal to explain the problem to staff. Only authorized staff can resolve it. After resolution, both participants can approve closing the thread, or staff can close it. Archived conversations are sent to participants as HTML transcripts when their DMs are open.' },
                { name: 'Server Trust and Rewards', value: 'Trust points, scam flags, and rank overrides are local to this server. A pair of traders can earn 5 points each only once per rolling 24 hours here; repeated completed deals still count as successful deals but add no extra points during that window. Manual administrator rank overrides are labeled separately from earned points in /profile.' },
                { name: 'Administrator Setup', value: '`/setup` — Read-only configuration and permission checklist.\n`/stats` — Private server activity counts for the last 30 days.\n`/set-hub-channel` — A regular text channel for private threads.\n`/set-mod-role` — Staff authorized to review disputes.\n`/set-rank-role` — Optional cosmetic roles for trust ranks.\n`/set-rank` — Set a local manual rank override, or choose Earned to reset it.\n`/review-flag` — Review and clear an active local scam flag with an audited reason.\n`/set-language` — English is the bot\'s language.' },
                { name: 'How Payments Work', value: 'DealBot tracks confirmations and conversations. It does not hold funds, send refunds, or independently verify a payment. Participants must check the payment and delivery themselves.' },
            )
            .setFooter({ text: 'DealBot • English throughout • /ping checks latency' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    },
};
