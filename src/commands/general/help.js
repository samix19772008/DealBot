const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Learn the three steps to buy from a market post and manage your deals')
        .setDMPermission(false),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Open /help inside your marketplace server.', ephemeral: true, allowedMentions: { parse: [] } });
        }
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('DealBot · Quick Guide')
            .setDescription('**Buy from the post. Follow the deal buttons. Find everything in My Deals.**')
            .addFields(
                { name: '1 · Request from the Seller\'s Post', value: 'Open the message menu → **Apps → Request a Deal**. Choose a product or pack, a payment option, and quantity. The post determines the total; you do not enter a price. The seller receives your request privately and accepts or declines. If their DMs are closed, the request is cancelled privately; ask them to enable DMs and try again.' },
                { name: '2 · Follow Your Private Conversation', value: 'The buyer confirms payment was sent. The seller checks it independently, delivers, and confirms delivery. The buyer checks the item and confirms receipt. Use **Open Dispute** if staff need to help. DealBot records confirmations; it does not hold funds, make refunds, or verify transfers.' },
                { name: '3 · Use My Deals', value: 'Use the button below or `/deals` for your requests, next actions, and history. Select a deal to open its conversation or available saved transcript. Quiet conversations can be tucked away without ending the deal; open an active conversation from My Deals when you need it again. `/profile` shows the trust record in this server.' },
                { name: 'Selling?', value: 'Keep your descriptions, emojis, and mentions. State product headings and prices clearly, then open **Apps → Preview Listing** on your own message to check what was detected. Different pack offers keep their own prices. A quantity counts packs. **1 stack = 64**; `5.32 Stack` means 5 stacks and 32 items. Stock 0 prevents ordering; positive stock is not reserved.' },
                { name: 'Server Administrator', value: 'Configuration is grouped under `/setup`. Start with `/setup hub` and `/setup staff`, then run `/setup check`. `/setup threads` adjusts conversation organization. Rank tools, flag reviews, and statistics are optional subcommands. Regular traders can use the message menu and My Deals.' },
            )
            .setFooter({ text: 'DealBot • Private deal coordination and records • English' });
        const controls = new ActionRowBuilder().addComponents(new ButtonBuilder()
            .setCustomId(`deals_page_${interaction.guildId}:${interaction.user.id}:active:1:refresh`)
            .setLabel('My Deals').setStyle(ButtonStyle.Primary));
        return interaction.reply({ embeds: [embed], components: [controls], ephemeral: true, allowedMentions: { parse: [] } });
    },
};
