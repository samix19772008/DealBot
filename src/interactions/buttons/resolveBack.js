const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { isModerator } = require('../../utils/permissions');
const { deny, getScopedDeal } = require('../helpers');

module.exports = {
    id: 'resolve_back_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isModerator(interaction.member, escrow.guild_id)) return deny(interaction, 'Only authorized moderators can resolve disputes.');
        if (escrow.status !== 'disputed') return deny(interaction, `This deal is ${escrow.status} and has no open dispute.`);
        const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Dispute Resolution')
            .setDescription(`Review deal \`${escrow.transaction_uuid}\` and choose the appropriate resolution.`)
            .addFields({ name: 'Dispute Reason', value: (escrow.dispute_reason || 'No reason recorded').slice(0, 1024) });
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`resolve_complete_${escrow.id}`).setLabel('Complete Deal').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`resolve_cancel_${escrow.id}`).setLabel('Cancel Deal').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`resolve_scammer_${escrow.id}`).setLabel('Flag a Scammer').setStyle(ButtonStyle.Danger),
        );
        await interaction.update({ content: null, embeds: [embed], components: [buttons] });
    },
};
