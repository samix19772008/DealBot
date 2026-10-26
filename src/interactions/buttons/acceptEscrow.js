const { formatPayment } = require('../../utils/payments');
const {
    ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} = require('discord.js');
const { getEscrowById, acceptEscrow } = require('../../database/escrowRepository');
const { getGuildSettings } = require('../../database/guildSettingsRepository');
const { buildDealEmbed } = require('../../utils/embedTemplate');
const { dealThreadName } = require('../../utils/threadPresentation');

const REQUIRED_BOT_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePrivateThreads,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
];

module.exports = {
    id: 'accept_escrow_',

    async execute(interaction) {
        const escrowId = interaction.customId.slice('accept_escrow_'.length);
        if (!/^\d+$/.test(escrowId)) {
            return interaction.reply({ content: 'This deal no longer exists.', ephemeral: true });
        }
        const escrow = getEscrowById(escrowId);
        if (!escrow) {
            return interaction.reply({ content: 'This deal no longer exists.', ephemeral: true });
        }
        if (interaction.guildId && interaction.guildId !== escrow.guild_id) {
            return interaction.reply({ content: 'This deal belongs to a different server.', ephemeral: true });
        }
        if (interaction.user.id !== escrow.seller_discord_id) {
            return interaction.reply({ content: 'Only the designated seller can accept this deal.', ephemeral: true });
        }
        if (escrow.status !== 'pending') {
            return interaction.reply({
                content: `This deal is already ${escrow.status.replaceAll('_', ' ')} and cannot be accepted again.`,
                ephemeral: true,
            });
        }

        await interaction.deferUpdate();
        const reject = content => interaction.followUp({ content, ephemeral: true });
        const guild = await interaction.client.guilds.fetch(escrow.guild_id).catch(() => null);
        if (!guild) {
            return reject('The bot cannot access the server where this deal was created.');
        }
        const settings = getGuildSettings(escrow.guild_id);
        if (!settings?.hub_channel_id) {
            return reject('The escrow hub is not configured. Ask an administrator to run `/set-hub-channel`.');
        }
        const hub = await guild.channels.fetch(settings.hub_channel_id).catch(() => null);
        if (!hub || hub.type !== ChannelType.GuildText) {
            return reject('The escrow hub must be an accessible regular text channel. Ask an administrator to update `/set-hub-channel`.');
        }

        const [botMember, buyerMember, sellerMember] = await Promise.all([
            guild.members.me || guild.members.fetchMe().catch(() => null),
            guild.members.fetch(escrow.buyer_discord_id).catch(() => null),
            guild.members.fetch(escrow.seller_discord_id).catch(() => null),
        ]);
        if (!buyerMember || !sellerMember) {
            return reject('Both the buyer and seller must still be members of this server before the deal can be accepted.');
        }
        if (!botMember || !hub.permissionsFor(botMember)?.has(REQUIRED_BOT_PERMISSIONS)) {
            return reject('The bot needs View Channel, Send Messages, Create Private Threads, Send Messages in Threads, Manage Threads, Read Message History, and Embed Links in the escrow hub.');
        }
        const participantPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads];
        if (![buyerMember, sellerMember].every(member => hub.permissionsFor(member)?.has(participantPermissions))) {
            return reject('Both participants need View Channel and Send Messages in Threads permissions in the escrow hub.');
        }

        let thread;
        let accepted = false;
        try {
            thread = await hub.threads.create({
                name: dealThreadName(escrow),
                type: ChannelType.PrivateThread,
                autoArchiveDuration: 1440,
                invitable: false,
                reason: `Deal ${escrow.transaction_uuid} accepted by seller`,
            });
            await Promise.all([
                thread.members.add(escrow.buyer_discord_id),
                thread.members.add(escrow.seller_discord_id),
            ]);

            const welcomeEmbed = buildDealEmbed({
                title: 'Escrow Deal Accepted',
                referenceId: escrow.transaction_uuid,
                status: 'info',
                rows: [
                    { label: 'Item or Service', value: escrow.item_description },
                    { label: 'Agreed Amount', value: formatPayment(escrow) },
                    { label: 'Next Step', value: 'The buyer confirms payment has been sent. The seller must independently verify receipt before delivering.' },
                    { label: 'Payment Tracking', value: 'DealBot records your confirmations. It does not hold, transfer, or verify money or items.' },
                    { label: 'Your Deals', value: 'Use `/deals` for your private dashboard, action reminders, and conversation links.' },
                ],
                footerNote: 'Open a dispute below if you need moderator assistance',
            });
            const disputeButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`open_dispute_${escrow.id}`)
                    .setLabel('Open Dispute')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('⚠️'),
            );
            await thread.send({
                content: `<@${escrow.buyer_discord_id}> <@${escrow.seller_discord_id}>`,
                allowedMentions: { parse: [], users: [escrow.buyer_discord_id, escrow.seller_discord_id] },
                embeds: [welcomeEmbed],
                components: [disputeButton],
            });

            const paymentEmbed = buildDealEmbed({
                title: 'Step 1: Confirm Payment Sent',
                status: 'pending',
                rows: [
                    { label: 'Buyer Action', value: `<@${escrow.buyer_discord_id}>, send the agreed payment, then confirm below. Do not click before sending payment.` },
                ],
                footerNote: 'Payment is confirmed by the buyer; the bot does not verify it',
            });
            const paymentButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_payment_${escrow.id}`)
                    .setLabel('Confirm Payment Sent')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('💰'),
            );
            await thread.send({ embeds: [paymentEmbed], components: [paymentButton], allowedMentions: { parse: [] } });

            accepted = acceptEscrow(escrow.id, thread.id, interaction.user.id);
            if (!accepted) {
                await thread.delete('Deal changed while its private thread was being prepared').catch(error => {
                    console.warn('[ACCEPT] Could not remove unused private thread:', error.message);
                });
                return reject('This deal changed while the private conversation was being prepared. Refresh its status with `/deal-status`.');
            }
        } catch (error) {
            if (thread && !accepted) {
                await thread.delete('Incomplete escrow thread setup').catch(cleanupError => {
                    console.warn('[ACCEPT] Could not remove incomplete private thread:', cleanupError.message);
                });
            }
            console.error('[ACCEPT] Failed to prepare private deal conversation:', error.message);
            return reject('The private conversation could not be prepared, so the deal was not accepted. Ask an administrator to check the hub permissions, then try again.');
        }

        const threadLink = `https://discord.com/channels/${guild.id}/${thread.id}`;
        const originalEmbed = interaction.message?.embeds?.[0];
        const updatedEmbed = (originalEmbed ? EmbedBuilder.from(originalEmbed) : new EmbedBuilder().setTitle('Escrow Deal Accepted'))
            .setColor(0x57F287)
            .setFooter({ text: `Accepted by ${interaction.user.tag}` })
            .setTimestamp();
        try {
            await interaction.editReply({
                content: `✅ Deal accepted. Continue in your [private deal conversation](${threadLink}).`,
                embeds: [updatedEmbed],
                components: [],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.warn('[ACCEPT] Deal accepted, but the original offer could not be updated:', error.message);
            await reject(`The deal was accepted. Continue in your private conversation: ${threadLink}`).catch(() => {});
        }

        try {
            await buyerMember.user.send({
                content: `✅ The seller accepted deal \`${escrow.transaction_uuid}\`.\nContinue in your private conversation: ${threadLink}`,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.warn(`[ACCEPT] Could not DM buyer ${escrow.buyer_discord_id}:`, error.message);
        }
    },
};
