const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { LISTING_TEMPLATE } = require('../../utils/listings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('listing-format')
        .setDescription('Learn how market posts, product packs, and fixed prices are read')
        .setDMPermission(false),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Use /listing-format inside your server.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Market Posts and Prices')
            .setDescription('Keep your sales descriptions, Markdown, custom emojis, and mentions. One post can contain several products or packs. Use clear product headings and price relationships, then preview what DealBot detected.')
            .addFields(
                { name: 'Optional Simple Template', value: `\`\`\`text\n${LISTING_TEMPLATE}\n\`\`\`` },
                { name: 'Example: Accept Golds Only', value: '```text\nItem: Menace Cape\nGolds: 33\n```\nOnly Golds appears in the payment menu. Quantity 1 costs 33 Golds; quantity 2 costs 66 Golds.' },
                { name: 'Example: Several Products', value: '```text\n# Special Rank\n- Money: 22$\n- Golds: 5.32 Stack\n# Emerald Rank\n- Money: 5.5$\n- Golds: 1.20 Stack\n```\nEach rank keeps its own payment methods and prices.' },
                { name: 'Example: Separate Pack Offers', value: '```text\n# Unbreaking II\n- 3 Books = 2 Sky1 Notchs\n- 9 Books = 5 Sky1 Notchs\nStock: 26\n```\nTwo packs of the 9-book offer mean 18 books for 10 Sky 1 Notchs.' },
                { name: 'Stacks and Price Clarity', value: 'Money is USD, with up to two decimals. Game payments use whole items or stacks of 64. In a post, `5.32 Stack` means **5 stacks + 32 items = 352**, and `1.20 Stack` means 84. The digits after the dot are leftover items, from 0 to 63; `.2` means 2 items. Payment methods are alternatives, not exchange rates.' },
                { name: 'Preview Your Post', value: 'Right-click your own message → **Apps → Preview Listing** to privately review detected products, pack sizes, prices, stock, and any unclear offers. Clear text prices are needed; image-only and embed-only prices are not read. Detection has limits and does not understand every possible sentence.' },
                { name: 'How Buyers Order', value: 'Right-click the post → **Apps → Request a Deal**. Choose a product or pack, then one of its offered payment methods and a quantity from **1 to 999**. DealBot calculates the total; buyers cannot edit prices. `Stock: 0` blocks ordering; positive stock is advertised information, not a reservation.' },
                { name: 'Edits and Custom Deals', value: 'A picker expires after 15 minutes. Editing the post requires reopening it; created requests keep their saved terms. `/deal` remains a separate negotiated request and does not enforce a post\'s prices.' },
            )
            .setFooter({ text: 'DealBot records confirmations; sellers must verify payment and availability.' });

        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    },
};
