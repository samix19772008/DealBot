const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const { parseCatalog } = require('./catalog');
const { formatPayment } = require('./payments');
const { getAccessibleSourceMessage } = require('./sourceMessage');

const PREVIEW_PAGE_SIZE = 5;

function buildCatalogPreview(catalog, { guildId, channelId, messageId, authorId, page = 0 }) {
    const pageCount = Math.max(1, Math.ceil(catalog.products.length / PREVIEW_PAGE_SIZE));
    const index = Math.min(pageCount - 1, Math.max(0, Number.isSafeInteger(page) ? page : 0));
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Listing Preview · Page ${index + 1}/${pageCount}`)
        .setDescription(`Detected **${catalog.products.length}** products or packs from your post. Review each price and pack before accepting requests. This preview does not create a deal.\n[View your post](https://discord.com/channels/${guildId}/${channelId}/${messageId})`);
    for (const product of catalog.products.slice(index * PREVIEW_PAGE_SIZE, (index + 1) * PREVIEW_PAGE_SIZE)) {
        const prices = product.options.map(option => `• ${formatPayment(option)}`).join('\n') || 'No clear, supported price.';
        const pack = product.bundleQuantity > 1 ? `\nPack: ${product.bundleQuantity} ${escapeMarkdown(product.bundleUnit || 'items')}` : '';
        const stock = product.stock == null ? '' : `\nAdvertised stock: ${product.stock.toLocaleString('en-US')}${product.stock === 0 ? ' — out of stock' : ' (not reserved)'}`;
        embed.addFields({ name: escapeMarkdown(product.item).slice(0, 256), value: `${prices}${pack}${stock}`.slice(0, 1024) });
    }
    if (catalog.warnings?.length) {
        embed.addFields({ name: 'Needs Review', value: catalog.warnings.slice(0, 5).map(warning => escapeMarkdown(warning)).join('\n').slice(0, 1024) });
    }
    embed.setFooter({ text: 'Decorations and mentions are allowed. Unclear prices must be clarified in the post.' });
    const components = [];
    if (pageCount > 1) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`listing_preview_${channelId}_${messageId}_${authorId}`)
            .setPlaceholder('Review another page')
            .addOptions(Array.from({ length: pageCount }, (_, target) => ({
                label: `Products ${target * PREVIEW_PAGE_SIZE + 1}–${Math.min((target + 1) * PREVIEW_PAGE_SIZE, catalog.products.length)}`,
                value: String(target), default: target === index,
            })));
        components.push(new ActionRowBuilder().addComponents(menu));
    }
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

async function showListingPreview(interaction, { channelId, messageId, authorId, page = 0, update = false }) {
    if (!interaction.guildId || authorId !== interaction.user.id) {
        return interaction.reply({ content: 'Preview Listing is available only to the author of the post, inside their server.', ephemeral: true, allowedMentions: { parse: [] } });
    }
    if (update) await interaction.deferUpdate();
    else await interaction.deferReply({ ephemeral: true });
    const source = await getAccessibleSourceMessage(interaction, channelId, messageId, { allowOwn: true });
    if (source.error) return interaction.editReply({ content: source.error, embeds: [], components: [], allowedMentions: { parse: [] } });
    if (source.message.author.id !== authorId) {
        return interaction.editReply({ content: 'You can preview only your own market posts.', embeds: [], components: [], allowedMentions: { parse: [] } });
    }
    let catalog;
    try { catalog = parseCatalog(source.message.content); }
    catch (error) {
        return interaction.editReply({ content: `The post needs a clearer price or product before it can be offered. ${error.message}`.slice(0, 1900), embeds: [], components: [], allowedMentions: { parse: [] } });
    }
    return interaction.editReply({ content: '', ...buildCatalogPreview(catalog, {
        guildId: interaction.guildId, channelId, messageId, authorId, page,
    }) });
}

module.exports = { PREVIEW_PAGE_SIZE, buildCatalogPreview, showListingPreview };
