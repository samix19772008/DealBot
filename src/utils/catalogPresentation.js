const { ActionRowBuilder, StringSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const { formatPayment } = require('./payments');

const CATALOG_PAGE_SIZE = 23;

function getSessionCatalog(session) {
    if (session?.catalog?.products?.length) return session.catalog;
    if (session?.listing?.options?.length) {
        return { version: 2, products: [{ id: 'p0', ...session.listing,
            bundleQuantity: 1, bundleUnit: null, stock: null }], warnings: [] };
    }
    throw new Error('This catalog is no longer available. Reopen Request a Deal on the seller\'s post.');
}

function getCatalogProduct(session, productId) {
    const catalog = getSessionCatalog(session);
    const product = productId == null && catalog.products.length === 1
        ? catalog.products[0]
        : catalog.products.find(candidate => candidate.id === productId);
    if (!product) throw new Error('Choose a product or pack offered in this post. Reopen Request a Deal if the post has changed.');
    return product;
}

function sourceUrl(session) {
    return `https://discord.com/channels/${session.guild_id}/${session.channel_id}/${session.message_id}`;
}

function warningNote(catalog) {
    return catalog.warnings?.length
        ? '\nSome lines could not be matched to clear prices. Only detected offers are shown; check the source post.'
        : '';
}

function packDescription(product) {
    if (product.bundleQuantity > 1) {
        return `${product.bundleQuantity} ${product.bundleUnit || 'items'} per pack`;
    }
    return '1 product per order';
}

function priceDescription(product) {
    const prices = product.options.map(option => formatPayment(option)).join(' / ');
    const availability = product.stock === 0 ? 'Sold out' :
        product.stock == null ? '' : `Stock: ${product.stock.toLocaleString('en-US')}`;
    return [availability, prices].filter(Boolean).join(' · ').slice(0, 100);
}

/** Discord permits at most 25 options, including the two page-navigation entries. */
function createCatalogResponse(session, page = 0) {
    const catalog = getSessionCatalog(session);
    const pages = Math.ceil(catalog.products.length / CATALOG_PAGE_SIZE);
    if (!Number.isInteger(page) || page < 0 || page >= pages) {
        throw new Error('This product page is unavailable. Reopen Request a Deal on the source post.');
    }
    const products = catalog.products.slice(page * CATALOG_PAGE_SIZE, (page + 1) * CATALOG_PAGE_SIZE);
    const options = products.map(product => ({
        label: `${product.stock === 0 ? 'Sold out · ' : ''}${product.item}`.slice(0, 100),
        value: product.id,
        description: priceDescription(product) || packDescription(product),
    }));
    if (page > 0) options.push({ label: 'Previous products', value: `page:${page - 1}`, description: `Page ${page} of ${pages}` });
    if (page + 1 < pages) options.push({ label: 'More products', value: `page:${page + 1}`, description: `Page ${page + 2} of ${pages}` });
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`deal_product_v3_${session.token}_${page}`)
        .setPlaceholder(`Choose a product or pack · ${page + 1}/${pages}`)
        .setMinValues(1).setMaxValues(1).addOptions(options);
    return {
        content: `Choose one detected product or pack from this post (${catalog.products.length} offers, page ${page + 1}/${pages}). Check its details against the seller's post; the seller still reviews every request.\n[View source post](${sourceUrl(session)})\nThis private picker expires after 15 minutes.${warningNote(catalog)}`,
        components: [new ActionRowBuilder().addComponents(menu)],
        allowedMentions: { parse: [] },
    };
}

/** A single-product picker retains the v2 controls used by existing open requests. */
function createPaymentResponse(session, productId) {
    const catalog = getSessionCatalog(session);
    const product = getCatalogProduct(session, productId);
    if (product.stock === 0) throw new Error('This product or pack is advertised as sold out. Choose another offer or ask the seller to update the post.');
    const single = catalog.products.length === 1;
    const menu = new StringSelectMenuBuilder()
        .setCustomId(single ? `deal_payment_method_v2_${session.token}` : `deal_payment_method_v3_${session.token}_${product.id}`)
        .setPlaceholder('Choose the payment method')
        .setMinValues(1).setMaxValues(1)
        .addOptions(product.options.map(method => ({
            label: method.label, value: method.key,
            description: `${formatPayment(method)} per ${product.bundleQuantity > 1 ? 'pack' : 'product'}`.slice(0, 100),
        })));
    const item = escapeMarkdown(product.item);
    const pack = product.bundleQuantity > 1
        ? `\nPack size: **${product.bundleQuantity} ${escapeMarkdown(product.bundleUnit || 'items')}**. Enter the number of packs, not individual items.`
        : '';
    const stock = product.stock == null ? '' : `\nAdvertised stock: **${product.stock.toLocaleString('en-US')}**. Availability is not reserved by this picker.`;
    return {
        content: `**${item}**${pack}${stock}\nChoose a payment method offered for this ${product.bundleQuantity > 1 ? 'pack' : 'product'}. Enter the quantity next; the total is calculated from the seller's fixed price. Review the [source post](${sourceUrl(session)}) before submitting. This request expires after 15 minutes.${warningNote(catalog)}`,
        components: [new ActionRowBuilder().addComponents(menu)],
        allowedMentions: { parse: [] },
    };
}

module.exports = { CATALOG_PAGE_SIZE, getSessionCatalog, getCatalogProduct,
    createCatalogResponse, createPaymentResponse };
