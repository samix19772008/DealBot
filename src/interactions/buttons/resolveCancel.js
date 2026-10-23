const { EmbedBuilder } = require('discord.js');
const { cancelEscrow } = require('../../database/escrowRepository');
const { isModerator } = require('../../utils/permissions');
const { deny, getScopedDeal, sendCloseControls } = require('../helpers');

module.exports = {
    id: 'resolve_cancel_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isModerator(interaction.member, escrow.guild_id)) return deny(interaction, 'Only authorized moderators can resolve disputes.');
        if (escrow.status !== 'disputed') return deny(interaction, `This deal is ${escrow.status} and has no open dispute.`);
        await interaction.deferUpdate();
        if (!cancelEscrow(escrow.id, { expectedStatus: 'disputed', actorId: interaction.user.id, reason: 'Dispute cancelled by moderator' })) {
            return deny(interaction, 'This dispute was already resolved. No further change was made.');
        }
        const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Dispute Resolved: Deal Cancelled')
            .setDescription(`Moderator <@${interaction.user.id}> cancelled deal \`${escrow.transaction_uuid}\`. Any refund must be arranged outside the bot.`).setTimestamp();
        await interaction.editReply({ content: null, embeds: [embed], components: [] });
        await sendCloseControls(interaction, escrow);
    },
};
