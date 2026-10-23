const { isModerator } = require('../../utils/permissions');
const { deny, getScopedDeal, confirmedEmbed, closeButtons } = require('../helpers');

module.exports = {
    id: 'admin_close_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isModerator(interaction.member, escrow.guild_id)) return deny(interaction, 'Only authorized moderators can force-close this conversation.');
        if (!['completed', 'cancelled', 'refunded'].includes(escrow.status)) {
            return deny(interaction, 'Resolve or complete this deal before closing its conversation.');
        }
        if (!interaction.channel?.isThread?.()) return deny(interaction, 'This action requires the private deal thread.');
        await interaction.deferUpdate();
        try {
            await interaction.channel.send(`🔒 Moderator <@${interaction.user.id}> closed this conversation. A transcript will be sent when it is archived.`);
            await interaction.editReply({ embeds: [confirmedEmbed(interaction, `Closed by moderator ${interaction.user.tag}`, 0x2B2D31)], components: [] });
            await interaction.channel.setLocked(true, `Closed by moderator ${interaction.user.id}`);
            await interaction.channel.setArchived(true, `Closed by moderator ${interaction.user.id}`);
        } catch (error) {
            console.warn('[CLOSE] Could not close deal thread:', error.message);
            await interaction.editReply({
                embeds: [confirmedEmbed(interaction, 'Closing failed. Check Manage Threads permission, then try again.', 0xED4245)],
                components: interaction.message?.components?.length ? interaction.message.components : [closeButtons(escrow.id)],
            });
            await deny(interaction, 'The conversation could not be closed. Check that the bot can manage threads, then try Force Close again.');
        }
    },
};
