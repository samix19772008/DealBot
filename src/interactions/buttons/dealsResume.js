const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getEscrowById } = require('../../database/escrowRepository');
const { markThreadReopened } = require('../../database/transcriptRepository');
const { rescheduleActiveThreadCleanup } = require('../../database/activeThreadOrganizationRepository');
const { isModerator } = require('../../utils/permissions');

const ACTIVE_CONVERSATIONS = new Set(['awaiting_payment', 'funded', 'delivered', 'disputed']);
const PARTICIPANT_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads];
const BOT_PERMISSIONS = [...PARTICIPANT_PERMISSIONS, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads];

function createResumeHandler({ getDeal = getEscrowById, moderator = isModerator, reopened = markThreadReopened,
    reschedule = rescheduleActiveThreadCleanup } = {}) {
    return {
        id: 'deals_resume_',
        async execute(interaction, suppliedClient) {
            const client = suppliedClient || interaction.client;
            const reference = interaction.customId?.slice(this.id.length);
            const original = /^\d+$/.test(reference || '') && getDeal(reference);
            const finish = content => {
                const payload = { content, components: [], allowedMentions: { parse: [] } };
                return interaction.deferred ? interaction.editReply(payload) : interaction.reply({ ...payload, ephemeral: true });
            };
            if (!interaction.guildId || !original || original.guild_id !== interaction.guildId) {
                return finish('This deal was not found in this server. Open /deals again.');
            }
            if (!ACTIVE_CONVERSATIONS.has(original.status) || !original.channel_id) {
                return finish('Only an active deal with a private conversation can be resumed. Finished conversations remain archived.');
            }
            await interaction.deferReply({ ephemeral: true });
            try {
                const guild = await client.guilds.fetch(original.guild_id);
                if (!guild || guild.id !== original.guild_id) throw new Error('ConversationAccess');

                // Fetch current Discord permissions and membership rather than trusting the menu or caches.
                const inspect = async () => {
                    const deal = getDeal(original.id);
                    if (!deal || deal.guild_id !== original.guild_id || deal.channel_id !== original.channel_id ||
                        !ACTIVE_CONVERSATIONS.has(deal.status)) return { ended: true };
                    const [thread, member, botMember] = await Promise.all([
                        guild.channels.fetch(deal.channel_id, { force: true, cache: false }),
                        guild.members.fetch({ user: interaction.user.id, force: true, cache: false }),
                        guild.members.fetchMe({ force: true, cache: false }),
                    ]);
                    if (!thread || thread.id !== deal.channel_id || thread.guildId !== deal.guild_id ||
                        thread.type !== ChannelType.PrivateThread || !member || member.id !== interaction.user.id ||
                        member.guild?.id !== deal.guild_id || !botMember || botMember.guild?.id !== deal.guild_id) {
                        throw new Error('ConversationAccess');
                    }
                    const parent = await guild.channels.fetch(thread.parentId, { force: true, cache: false });
                    if (!parent || parent.id !== thread.parentId || parent.guildId !== deal.guild_id ||
                        parent.type !== ChannelType.GuildText) throw new Error('ConversationAccess');
                    const participant = [deal.buyer_discord_id, deal.seller_discord_id].includes(member.id);
                    const staff = moderator(member, deal.guild_id);
                    if (!participant && !staff) throw new Error('ConversationAccess');
                    if (![parent, thread].every(channel => channel.permissionsFor(member)?.has(PARTICIPANT_PERMISSIONS)) ||
                        ![parent, thread].every(channel => channel.permissionsFor(botMember)?.has(BOT_PERMISSIONS))) {
                        throw new Error('ConversationAccess');
                    }
                    const manage = [parent, thread].every(channel => channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads));
                    if (!(staff && manage)) {
                        // Being a participant in the database never restores a removed private-thread member.
                        const membership = await thread.members.fetch({ member: member.id, force: true, cache: false });
                        if (!membership || membership.id !== member.id) throw new Error('ConversationAccess');
                    }
                    return { thread, staff, manage };
                };

                let inspected = await inspect();
                if (inspected.ended) return finish('This deal has ended or changed. Refresh /deals to view its current status.');
                // Network calls above can span status/permission changes. Check both again before mutation.
                inspected = await inspect();
                if (inspected.ended) return finish('This deal has ended or changed. Refresh /deals to view its current status.');
                const { thread, staff, manage } = inspected;
                if (client.dealBotStopping) return finish('DealBot is restarting. Please try resuming this conversation again in a moment.');
                const latest = getDeal(original.id);
                if (!latest || latest.channel_id !== original.channel_id || latest.guild_id !== original.guild_id ||
                    !ACTIVE_CONVERSATIONS.has(latest.status)) {
                    return finish('This deal has ended or changed. Refresh /deals to view its current status.');
                }
                if (thread.archived) {
                    if (thread.locked && !(staff && manage)) {
                        return finish('This conversation was locked by staff. Ask an authorized moderator to resume it.');
                    }
                    const reason = `Active deal ${latest.transaction_uuid} resumed by ${interaction.user.id}`;
                    try {
                        if (thread.locked) await thread.edit({ archived: false, locked: false, reason });
                        else await thread.setArchived(false, reason);
                    } catch (error) {
                        // A lost HTTP response can follow a successful Discord edit.
                        const actual = await guild.channels.fetch(thread.id, { force: true, cache: false }).catch(() => null);
                        if (!actual || actual.guildId !== original.guild_id || actual.type !== ChannelType.PrivateThread || actual.archived) throw error;
                    }
                    reopened(latest.id);
                    reschedule(latest.id);
                }
                return finish(`Continue in your private deal conversation: https://discord.com/channels/${original.guild_id}/${original.channel_id}`);
            } catch (error) {
                console.warn('[RESUME] Could not access or resume deal conversation:', error.code || error.name || 'UnknownError');
                return finish('This conversation could not be resumed. You must still have access to its private thread, and the bot needs Manage Threads permission. Ask staff for help if access changed.');
            }
        },
    };
}

module.exports = createResumeHandler();
module.exports.createResumeHandler = createResumeHandler;
