const { showListingPreview } = require('../../utils/catalogPreview');
const { deny } = require('../helpers');

module.exports = {
    id: 'listing_preview_',
    async execute(interaction) {
        const match = interaction.customId.match(/^listing_preview_(\d{1,20})_(\d{1,20})_(\d{1,20})$/);
        if (!match || interaction.values?.length !== 1 || !/^(?:0|[1-9]\d?)$/.test(interaction.values[0])) {
            return deny(interaction, 'Open Preview Listing on your own market post again.');
        }
        const [, channelId, messageId, authorId] = match;
        return showListingPreview(interaction, { channelId, messageId, authorId, page: Number(interaction.values[0]), update: true });
    },
};
