const { isModerator } = require('../../utils/permissions');
const { closeDealThread } = require('../../utils/threadClosure');
const { deny, getScopedDeal, confirmedEmbed, closeButtons } = require('../helpers');

async function reportMetadataDelay(interaction, result) {
    if (!result.metadataPending) return;
    console.warn('[CLOSE] Conversation archived; closure metadata is pending:', result.metadataError?.message || 'No archive record returned');
    await deny(interaction, 'The conversation was archived successfully. Its closure details are still being finalized.').catch(() => {});
}

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
        const options = {
            channel: interaction.channel, escrowId: escrow.id, actor: interaction.user,
            kind: 'moderator', reason: `Closed by moderator ${interaction.user.id}`,
        };
        try {
            if (!interaction.channel.archived) {
                await interaction.channel.send(`🔒 Moderator <@${interaction.user.id}> requested closing this conversation. A transcript will be sent after it is archived.`);
                await interaction.editReply({
                    embeds: [confirmedEmbed(interaction, `Closure requested by moderator ${interaction.user.tag}`, 0x2B2D31)], components: [],
                });
            }
            const result = await closeDealThread(options);
            await reportMetadataDelay(interaction, result);
        } catch (error) {
            // A Gateway update may reveal an external archive while a UI request fails.
            if (interaction.channel.archived) {
                const result = await closeDealThread(options);
                await reportMetadataDelay(interaction, result);
                return;
            }
            console.warn('[CLOSE] Could not close deal thread:', error.message);
            await interaction.editReply({
                embeds: [confirmedEmbed(interaction, 'Closing failed. Check Manage Threads permission, then try again.', 0xED4245)],
                components: interaction.message?.components?.length ? interaction.message.components : [closeButtons(escrow.id)],
            });
            await deny(interaction, 'The conversation could not be closed. Check that the bot can manage threads, then try Force Close again.');
        }
    },
};
