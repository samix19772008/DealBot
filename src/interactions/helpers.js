const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getEscrowById, getEscrowReward } = require('../database/escrowRepository');
const { syncMemberRankRole } = require('../utils/roleSync');

async function deny(interaction, content) {
    const payload = { content, ephemeral: true };
    return interaction.deferred || interaction.replied
        ? interaction.followUp(payload)
        : interaction.reply(payload);
}

async function getScopedDeal(interaction, id, { allowDm = false } = {}) {
    const escrow = getEscrowById(id);
    if (!escrow) {
        await deny(interaction, 'This deal no longer exists.');
        return null;
    }
    if (interaction.guildId && interaction.guildId !== escrow.guild_id) {
        await deny(interaction, 'This deal belongs to another server.');
        return null;
    }
    if ((!interaction.guildId && !allowDm) ||
        (!allowDm && (!escrow.channel_id || interaction.channelId !== escrow.channel_id))) {
        await deny(interaction, 'Use this action in the private conversation for this deal.');
        return null;
    }
    return escrow;
}

function isParticipant(interaction, escrow) {
    return [escrow.buyer_discord_id, escrow.seller_discord_id].includes(interaction.user.id);
}

function confirmedEmbed(interaction, text, color = 0x23A55A) {
    const original = interaction.message?.embeds?.[0];
    return (original ? EmbedBuilder.from(original) : new EmbedBuilder().setTitle('Deal Update'))
        .setColor(color)
        .setFooter({ text: text.slice(0, 2048) })
        .setTimestamp();
}

function closeButtons(escrowId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_close_${escrowId}`).setLabel('Approve Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId(`admin_close_${escrowId}`).setLabel('Force Close (Moderator)').setStyle(ButtonStyle.Danger).setEmoji('⚡'),
    );
}

async function sendCloseControls(interaction, escrow) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Close Conversation')
        .setDescription(`Deal \`${escrow.transaction_uuid}\` has ended. Both participants can approve closing this conversation.`)
        .addFields(
            { name: 'Buyer Approval', value: escrow.buyer_close_approved ? '✅ Approved' : '⬜ Pending', inline: true },
            { name: 'Seller Approval', value: escrow.seller_close_approved ? '✅ Approved' : '⬜ Pending', inline: true },
        )
        .setFooter({ text: 'DealBot • A transcript is sent when this conversation is archived.' });
    const buttons = closeButtons(escrow.id);
    await interaction.channel.send({ embeds: [embed], components: [buttons] });
}

async function syncDealRanks(interaction, escrow) {
    for (const id of [escrow.buyer_discord_id, escrow.seller_discord_id]) {
        try {
            const member = await interaction.guild.members.fetch(id);
            await syncMemberRankRole(member);
        } catch (error) {
            console.warn(`[ROLE SYNC] Could not update rank for ${id}:`, error.message);
        }
    }
}

function completionRewardText(escrowId) {
    const reward = getEscrowReward(escrowId);
    if (!reward) return 'The deal is completed. Use /profile to view the reputation recorded in this server.';
    if (reward.awarded_points > 0) {
        return `Both participants earned ${reward.awarded_points} trust points and one successful deal in this server.`;
    }
    return 'Both participants recorded one successful deal in this server. No trust points were added for this deal. The same pair can earn points only once per 24 hours in this server.';
}

module.exports = { deny, getScopedDeal, isParticipant, confirmedEmbed, closeButtons, sendCloseControls, syncDealRanks, completionRewardText };
