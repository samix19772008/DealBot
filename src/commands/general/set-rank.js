const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getOrCreateUser } = require('../../database/userRepository');
const { getGuildReputation, setGuildRankOverride, clearGuildRankOverride } = require('../../database/reputationRepository');
const { getRankByKey, getRankForScore, RANKS } = require('../../utils/ranks');
const { syncMemberRankRole } = require('../../utils/roleSync');

module.exports = {
    registered: false,
    data: new SlashCommandBuilder()
        .setName('set-rank')
        .setDescription('Set or reset a member\'s manual rank override in this server')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option => option
            .setName('user').setDescription('A current member of this server').setRequired(true))
        .addStringOption(option => option
            .setName('rank').setDescription('The local rank override, or reset to earned points').setRequired(true)
            .addChoices(
                ...RANKS.map(rank => ({ name: `${rank.emoji} ${rank.label}`, value: rank.key })),
                { name: 'Reset to earned points', value: 'earned' },
            )),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can manually change trust ranks.', ephemeral: true });
        }
        const targetUser = interaction.options.getUser('user');
        const choice = interaction.options.getString('rank');
        const rank = getRankByKey(choice);
        if ((!rank && choice !== 'earned') || !targetUser || targetUser.bot) {
            return interaction.reply({ content: 'Choose a valid member and trust rank.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member || member.guild?.id !== interaction.guildId) {
            return interaction.editReply({ content: 'The user must currently belong to this server. No rank changes were saved.' });
        }
        const identity = getOrCreateUser(targetUser);
        const reputation = getGuildReputation(interaction.guildId, identity.id);
        if (reputation.is_scammer && choice !== 'earned') {
            return interaction.editReply({ content: 'This member has an active scam flag in this server. Review the flag separately before assigning a trust rank.' });
        }
        if (choice === 'earned') {
            clearGuildRankOverride(interaction.guildId, identity.id, interaction.user.id);
        } else {
            setGuildRankOverride(interaction.guildId, identity.id, rank.minPoints, interaction.user.id);
        }
        const updated = getGuildReputation(interaction.guildId, identity.id);
        const activeRank = getRankForScore(updated.trust_score);
        const synced = await syncMemberRankRole(member);
        const result = choice === 'earned'
            ? `The manual rank override for <@${targetUser.id}> was cleared. Their rank now uses ${updated.earned_points} earned points.`
            : `<@${targetUser.id}> now has a local override of ${rank.minPoints} points (${rank.emoji} **${rank.label}**). Their ${updated.earned_points} earned points were preserved.`;
        return interaction.editReply({
            content: `✅ ${result}\nThis server only. Active rank: ${activeRank.emoji} **${activeRank.label}**.${updated.is_scammer ? ' The active scam flag still blocks trust roles and new deals.' : ''}${synced ? '' : ' The record was saved, but Discord roles could not be fully synchronized. Check role configuration and bot permissions.'}`,
            allowedMentions: { parse: [] },
        });
    },
};
