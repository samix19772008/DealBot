const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getEscrowById } = require('../../database/escrowRepository');

const ACTIVE = new Set(['awaiting_payment', 'funded', 'delivered']);
const MEMBER_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads];
const BOT_PERMISSIONS = [...MEMBER_PERMISSIONS, PermissionFlagsBits.ManageThreads];
const FRESH = { force: true, cache: false };

function createHideHandler({ getDeal = getEscrowById } = {}) {
    return {
        id: 'deals_hide_',
        async execute(interaction, suppliedClient) {
            const client = suppliedClient || interaction.client;
            const reference = interaction.customId?.slice(this.id.length);
            const original = /^\d+$/.test(reference || '') && getDeal(reference);
            const participant = deal => [deal?.buyer_discord_id, deal?.seller_discord_id].includes(interaction.user.id);
            const finish = content => {
                const payload = { content, allowedMentions: { parse: [] } };
                return interaction.deferred ? interaction.editReply(payload) : interaction.reply({ ...payload, ephemeral: true });
            };
            if (!original || !interaction.guildId || original.guild_id !== interaction.guildId || !participant(original)) {
                return finish('This deal was not found, or it is not one of your deals in this server.');
            }
            if (!ACTIVE.has(original.status) || !original.channel_id) {
                return finish('Only an active, undisputed deal conversation can be hidden. Finished conversations use the normal close controls.');
            }
            await interaction.deferReply({ ephemeral: true });
            try {
                const guild = await client.guilds.fetch(original.guild_id);
                if (!guild || guild.id !== original.guild_id) throw new Error('ConversationAccess');
                const inspect = async () => {
                    const deal = getDeal(original.id);
                    if (!deal || !ACTIVE.has(deal.status) || !participant(deal) || deal.guild_id !== original.guild_id ||
                        deal.channel_id !== original.channel_id) return null;
                    const [thread, member, bot] = await Promise.all([
                        guild.channels.fetch(deal.channel_id, FRESH),
                        guild.members.fetch({ user: interaction.user.id, ...FRESH }), guild.members.fetchMe(FRESH),
                    ]);
                    if (!thread || thread.id !== deal.channel_id || thread.guildId !== deal.guild_id ||
                        thread.type !== ChannelType.PrivateThread || !member || member.id !== interaction.user.id ||
                        member.guild?.id !== deal.guild_id || bot?.guild?.id !== deal.guild_id) throw new Error('ConversationAccess');
                    const parent = await guild.channels.fetch(thread.parentId, FRESH);
                    if (!parent || parent.id !== thread.parentId || parent.guildId !== deal.guild_id || parent.type !== ChannelType.GuildText ||
                        ![parent, thread].every(channel => channel.permissionsFor(member)?.has(MEMBER_PERMISSIONS)) ||
                        ![parent, thread].every(channel => channel.permissionsFor(bot)?.has(BOT_PERMISSIONS))) throw new Error('ConversationAccess');
                    const membership = await thread.members.fetch({ member: member.id, ...FRESH });
                    if (!membership || membership.id !== member.id) throw new Error('ConversationAccess');
                    return thread;
                };
                let thread = await inspect();
                if (thread) thread = await inspect();
                if (!thread || client.dealBotStopping) return finish('This deal has changed or DealBot is restarting. Refresh My Deals and try again.');
                if (thread.locked) return finish('This conversation is locked by staff. Ask a moderator for help.');
                // The shared router lock excludes other deal actions in this process.
                const latest = getDeal(original.id);
                if (!latest || !ACTIVE.has(latest.status) || latest.channel_id !== original.channel_id ||
                    latest.guild_id !== original.guild_id || !participant(latest)) return finish('This deal has changed. Refresh My Deals.');
                if (!thread.archived) {
                    try { await thread.setArchived(true, `Active deal ${latest.transaction_uuid} hidden by a participant`); }
                    catch (error) {
                        const actual = await guild.channels.fetch(thread.id, FRESH).catch(() => null);
                        if (!actual || actual.id !== thread.id || actual.guildId !== original.guild_id ||
                            actual.type !== ChannelType.PrivateThread || !actual.archived) throw error;
                    }
                }
                return finish('Conversation archived for both participants. Your deal is still active and all messages are kept. Open My Deals and choose Open Conversation whenever you need it. No closing transcript is sent for hiding an active deal.');
            } catch (error) {
                console.warn('[HIDE] Could not hide conversation:', error.code ?? error.name);
                return finish('This conversation could not be hidden. You must still be a member of its private thread, and DealBot needs Manage Threads permission.');
            }
        },
    };
}

module.exports = createHideHandler();
module.exports.createHideHandler = createHideHandler;
