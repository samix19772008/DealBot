const { formatPayment } = require('../../utils/payments');
const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { getEscrowById, getEscrowEvents } = require('../../database/escrowRepository');
const { isModerator } = require('../../utils/permissions');
const { buildDealControls } = require('../../utils/dealControls');

const displayStatus = status => String(status).replaceAll('_', ' ');
const shorten = (text, limit) => String(text).length > limit ? `${String(text).slice(0, limit - 1)}…` : String(text);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deal-status')
        .setDescription('Privately inspect a deal and its recorded status timeline')
        .setDMPermission(false)
        .addStringOption(option => option
            .setName('reference').setDescription('The ESC- reference or numeric deal ID')
            .setMinLength(1).setMaxLength(50).setRequired(true)),

    async execute(interaction) {
        const reference = interaction.options.getString('reference')?.trim();
        const escrow = reference && getEscrowById(reference);
        const participant = escrow && [escrow.buyer_discord_id, escrow.seller_discord_id].includes(interaction.user.id);
        const moderator = Boolean(interaction.guildId && isModerator(interaction.member, interaction.guildId));
        if (!interaction.guildId || !escrow || escrow.guild_id !== interaction.guildId ||
            (!participant && !moderator)) {
            return interaction.reply({ content: 'This deal was not found, or you do not have permission to view it.', ephemeral: true });
        }
        const events = getEscrowEvents(escrow.id, 6);
        const timeline = events.map(event => {
            const state = event.to_status ? displayStatus(event.to_status) : displayStatus(event.event_type);
            const actor = event.actor_discord_id ? ` by <@${event.actor_discord_id}>` : '';
            const date = Number.isFinite(Date.parse(`${event.created_at.replace(' ', 'T')}Z`))
                ? `<t:${Math.floor(Date.parse(`${event.created_at.replace(' ', 'T')}Z`) / 1000)}:f>`
                : event.created_at;
            const reason = event.reason ? ` — ${escapeMarkdown(shorten(event.reason, 70))}` : '';
            return `${date} · **${state}**${actor}${reason}`;
        }).join('\n');
        const embed = new EmbedBuilder()
            .setColor(escrow.status === 'disputed' ? 0xED4245 : escrow.status === 'completed' ? 0x23A55A : 0x5865F2)
            .setTitle('Deal Status')
            .setDescription(`\`${escrow.transaction_uuid}\``)
            .addFields(
                { name: 'Status', value: displayStatus(escrow.status), inline: true },
                { name: 'Amount', value: formatPayment(escrow), inline: true },
                { name: 'Buyer', value: `<@${escrow.buyer_discord_id}>`, inline: true },
                { name: 'Seller', value: `<@${escrow.seller_discord_id}>`, inline: true },
                { name: 'Item or Service', value: shorten(escapeMarkdown(escrow.item_description), 1000) },
                { name: 'Recent Activity · Newest First', value: shorten(timeline || 'No recorded activity. Older deals may predate the activity log.', 1024) },
            )
            .setFooter({ text: 'DealBot • Payment confirmations are recorded statements, not verified transfers' })
            .setTimestamp();
        if (escrow.dispute_reason) {
            embed.addFields({ name: 'Dispute Reason', value: shorten(escapeMarkdown(escrow.dispute_reason), 1000) });
        }
        if (escrow.channel_id) {
            embed.addFields({ name: 'Conversation', value: `[Open private thread](https://discord.com/channels/${interaction.guildId}/${escrow.channel_id})` });
        }
        const insideDealThread = Boolean(escrow.channel_id && interaction.channelId === escrow.channel_id);
        const components = escrow.status === 'pending' || insideDealThread
            ? buildDealControls(escrow, { moderator, userId: interaction.user.id })
            : [];
        if (components.length) {
            embed.addFields({ name: 'Current Controls', value: 'Use the buttons below to continue from the saved deal status. Each action still requires the designated participant or authorized staff.' });
        } else if (escrow.status !== 'pending' && !insideDealThread) {
            embed.addFields({ name: 'Current Controls', value: 'Run /deal-status inside the private thread to restore current controls.' });
        } else if (escrow.status === 'disputed') {
            embed.addFields({ name: 'Current Controls', value: 'This deal is awaiting review by authorized staff.' });
        }
        return interaction.reply({ embeds: [embed], components, ephemeral: true, allowedMentions: { parse: [] } });
    },
};
