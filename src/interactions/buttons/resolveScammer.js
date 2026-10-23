const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { isModerator } = require('../../utils/permissions');
const { deny, getScopedDeal } = require('../helpers');

module.exports = {
    id: 'resolve_scammer_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isModerator(interaction.member, escrow.guild_id)) return deny(interaction, 'Only authorized moderators can resolve disputes.');
        if (escrow.status !== 'disputed') return deny(interaction, `This deal is ${escrow.status} and has no open dispute.`);
        await interaction.deferUpdate();
        const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Confirm Scammer Flag')
            .setDescription(`Choose the party to flag for deal \`${escrow.transaction_uuid}\`. This cancels the deal and adds a confirmed scam flag to that user's trust record.`)
            .addFields(
                { name: 'Buyer', value: `<@${escrow.buyer_discord_id}>` },
                { name: 'Seller', value: `<@${escrow.seller_discord_id}>` },
            );
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`scammer_pick_buyer_${escrow.id}`).setLabel('Flag Buyer').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`scammer_pick_seller_${escrow.id}`).setLabel('Flag Seller').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`resolve_back_${escrow.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({ content: null, embeds: [embed], components: [buttons] });
    },
};
