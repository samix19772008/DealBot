const { formatPayment } = require('../../utils/payments');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');
const { getEscrowById, getEscrowEvents } = require('../../database/escrowRepository');
const { expirePendingOffers } = require('../../database/offerPolicyRepository');
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
        return showDealStatus(interaction, interaction.options.getString('reference'));
    },
    showDealStatus,
};

async function showDealStatus(interaction, suppliedReference, { allowResume = false } = {}) {
        const reference = typeof suppliedReference === 'string' ? suppliedReference.trim() : '';
        if (interaction.guildId) expirePendingOffers({ guildId: interaction.guildId });
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
        let components = escrow.status === 'pending' || insideDealThread
            ? buildDealControls(escrow, { moderator, userId: interaction.user.id })
            : [];
        if (components.length) {
            embed.addFields({ name: 'Current Controls', value: 'Use the buttons below to continue from the saved deal status. Each action still requires the designated participant or authorized staff.' });
        } else if (escrow.status !== 'pending' && !escrow.channel_id) {
            embed.addFields({ name: 'Current Controls', value: 'This request ended before a private conversation was created.' });
        } else if (escrow.status !== 'pending' && !insideDealThread) {
            embed.addFields({ name: 'Current Controls', value: 'Run /deal-status inside the private thread to restore current controls.' });
        } else if (escrow.status === 'disputed') {
            embed.addFields({ name: 'Current Controls', value: 'This deal is awaiting review by authorized staff.' });
        }
        if (allowResume && !insideDealThread && escrow.channel_id &&
            ['awaiting_payment', 'funded', 'delivered', 'disputed'].includes(escrow.status)) {
            components = [new ActionRowBuilder().addComponents(new ButtonBuilder()
                .setCustomId(`deals_resume_${escrow.id}`).setLabel('Resume Conversation').setStyle(ButtonStyle.Primary))];
            embed.addFields({ name: 'Resume Conversation', value: 'Open or resume this active deal conversation. Access is checked again; completed conversations remain archived.' });
        }
        return interaction.reply({ embeds: [embed], components, ephemeral: true, allowedMentions: { parse: [] } });
}
