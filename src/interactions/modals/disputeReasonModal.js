const { formatPayment } = require('../../utils/payments');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { markAsDisputed } = require('../../database/escrowRepository');
const { getGuildSettings } = require('../../database/guildSettingsRepository');
const { deny, getScopedDeal, isParticipant } = require('../helpers');

module.exports = {
    id: 'dispute_reason_modal_',
    async execute(interaction) {
        const escrow = await getScopedDeal(interaction, interaction.customId.slice(this.id.length));
        if (!escrow) return;
        if (!isParticipant(interaction, escrow)) return deny(interaction, 'Only the buyer or seller can open a dispute.');
        if (!['awaiting_payment', 'funded', 'delivered'].includes(escrow.status)) {
            return deny(interaction, `This deal is ${escrow.status}; a new dispute cannot be opened.`);
        }
        const reason = interaction.fields.getTextInputValue('reason')?.trim() || '';
        if (reason.length < 10 || reason.length > 1000) {
            return deny(interaction, 'Please describe the problem in 10 to 1,000 characters.');
        }
        const settings = getGuildSettings(escrow.guild_id);
        if (!settings?.moderator_role_id) return deny(interaction, 'The moderator role is not configured. Ask an administrator to run /set-mod-role.');
        await interaction.deferReply();
        const role = await interaction.guild.roles.fetch(settings.moderator_role_id).catch(() => null);
        const requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads];
        if (!role || !interaction.channel.permissionsFor(role)?.has(requiredPermissions)) {
            return interaction.editReply({ content: 'The configured moderator role is unavailable or cannot access this private thread. An administrator must grant View Channel, Read Message History, Send Messages in Threads, and Manage Threads before opening a dispute.' });
        }
        if (!markAsDisputed(escrow.id, reason, interaction.user.id)) {
            return interaction.editReply({ content: 'This deal changed while you were responding. Check its current status before continuing.' });
        }
        const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Dispute Opened')
            .setDescription(`Opened by <@${interaction.user.id}>. Further payment, delivery, and receipt confirmations are paused until a moderator resolves this dispute.`)
            .addFields(
                { name: 'Deal Reference', value: `\`${escrow.transaction_uuid}\``, inline: true },
                { name: 'Amount', value: formatPayment(escrow), inline: true },
                { name: 'Reason', value: reason },
            )
            .setFooter({ text: 'Only authorized moderators can choose a resolution. The bot does not issue refunds.' }).setTimestamp();
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`resolve_complete_${escrow.id}`).setLabel('Complete Deal').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId(`resolve_cancel_${escrow.id}`).setLabel('Cancel Deal').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
            new ButtonBuilder().setCustomId(`resolve_scammer_${escrow.id}`).setLabel('Flag a Scammer').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
        );
        await interaction.editReply({
            content: `<@&${role.id}> — please review this dispute.`, embeds: [embed], components: [buttons],
            allowedMentions: { parse: [], roles: [role.id] },
        });
    },
};
