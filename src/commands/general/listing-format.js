const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { LISTING_TEMPLATE } = require('../../utils/listings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('listing-format')
        .setDescription('Copy a seller listing template with fixed prices for Request a Deal')
        .setDMPermission(false),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Use /listing-format inside your server.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Seller Listing Format')
            .setDescription('Post one product per message. Set the price for **one product**, and remove every payment line you do not accept. Prices are separate alternatives, not exchange rates.')
            .addFields(
                { name: 'Copy and Edit This Template', value: `\`\`\`text\n${LISTING_TEMPLATE}\n\`\`\`` },
                { name: 'Example: Accept Golds Only', value: '```text\nItem: Menace Cape\nGolds: 33\n```\nOnly Golds appears in the payment menu. Quantity 1 costs 33 Golds; quantity 2 costs 66 Golds.' },
                { name: 'Format Rules', value: 'Keep the English labels shown above. Include one `Item:` line and at least one price line, with no duplicate methods or extra text. Money is USD with up to two decimals. Game prices use whole items or whole `stacks`; 1 stack = 64 items. Images may accompany valid text, but image-only and embed-only prices are not read.' },
                { name: 'How Buyers Order', value: 'Right-click the post → **Apps → Request a Deal**. Choose one listed payment method, then a whole product quantity from **1 to 999**. DealBot calculates the total; buyers cannot edit the price or payment unit. Payment limits still apply.' },
                { name: 'Edits and Custom Deals', value: 'A payment picker expires after 15 minutes. Editing the post requires buyers to reopen it; requests already created keep their saved terms. `/deal` remains a separate negotiated request and does not enforce a post\'s prices. Listing quantities do not reserve or track stock.' },
            )
            .setFooter({ text: 'DealBot records confirmations; sellers must verify payment and availability.' });

        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    },
};
