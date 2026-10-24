const { EmbedBuilder } = require('discord.js');
const { flagScammerAndCancel } = require('../../database/escrowRepository');
const { isModerator } = require('../../utils/permissions');
const { deny, getScopedDeal, sendCloseControls, syncDealRanks } = require('../helpers');

module.exports = {
    id: 'scammer_pick_',
    async execute(interaction) {
        const match = interaction.customId.match(/^scammer_pick_(buyer|seller)_(\d+)$/);
        if (!match) return deny(interaction, 'This scammer selection is invalid. Open the dispute controls again.');
        const [, role, escrowId] = match;
        const escrow = await getScopedDeal(interaction, escrowId);
        if (!escrow) return;
        if (!isModerator(interaction.member, escrow.guild_id)) return deny(interaction, 'Only authorized moderators can resolve disputes.');
        if (escrow.status !== 'disputed') return deny(interaction, `This deal is ${escrow.status} and has no open dispute.`);
        await interaction.deferUpdate();
        const flaggedId = escrow[`${role}_id`];
        const flaggedDiscordId = escrow[`${role}_discord_id`];
        if (!flagScammerAndCancel(escrow.id, flaggedId, interaction.user.id)) {
            return deny(interaction, 'This dispute was already resolved. No additional scam flag was added.');
        }
        await syncDealRanks(interaction, escrow);
        const embed = new EmbedBuilder().setColor(0x2B2D31).setTitle('Dispute Resolved: Scammer Flagged')
            .setDescription(`Moderator <@${interaction.user.id}> flagged <@${flaggedDiscordId}> as a scammer. Deal \`${escrow.transaction_uuid}\` was cancelled.`)
            .setFooter({ text: 'This flag applies in this server only. An administrator can review it with /review-flag. No ban or refund is issued.' }).setTimestamp();
        await interaction.editReply({ content: null, embeds: [embed], components: [] });
        await sendCloseControls(interaction, escrow);
    },
};
