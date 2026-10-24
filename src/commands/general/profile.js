const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOrCreateUser } = require('../../database/userRepository');
const { getRankForScore, RANKS } = require('../../utils/ranks');
const { getGuildReputation } = require('../../database/reputationRepository');

function formatDuration(days) {
    if (!Number.isFinite(days) || days < 0) return 'Unknown';
    if (days < 1) return 'Less than a day';
    if (days < 30) return `${days} day${days === 1 ? '' : 's'}`;
    if (days < 365) {
        const months = Math.floor(days / 30);
        return `${months} month${months === 1 ? '' : 's'}`;
    }
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? '' : 's'}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription("View a user's reputation and rank progress in this server")
        .setDMPermission(false)
        .addUserOption(option => option
            .setName('user')
            .setDescription('The user to look up (defaults to you)')
            .setRequired(false)),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.guild) {
            return interaction.reply({ content: 'Use this command in a server.', ephemeral: true });
        }
        await interaction.deferReply();

        const targetUser = interaction.options.getUser('user') ?? interaction.user;
        const dbUser = getOrCreateUser(targetUser);
        const reputation = getGuildReputation(interaction.guildId, dbUser.id);
        const rank = getRankForScore(reputation.trust_score);
        const nextRank = RANKS.find(candidate => candidate.minPoints > reputation.trust_score);
        const accountAgeDays = Math.floor((Date.now() - targetUser.createdAt.getTime()) / 86400000);

        let joinedServerText = 'Not currently a member';
        try {
            const member = await interaction.guild.members.fetch(targetUser.id);
            if (member.joinedTimestamp) {
                const joinAgeDays = Math.floor((Date.now() - member.joinedTimestamp) / 86400000);
                joinedServerText = `${formatDuration(joinAgeDays)} ago`;
            } else {
                joinedServerText = 'Unknown';
            }
        } catch {
            // A user can have a trust record after leaving this server.
        }

        const flagged = Boolean(reputation.is_scammer);
        const rankProgress = nextRank
            ? `${Math.max(0, nextRank.minPoints - reputation.trust_score)} points to ${nextRank.label}`
            : 'Highest rank reached';
        const override = reputation.rank_override_points;
        const embed = new EmbedBuilder()
            .setColor(flagged ? 0xED4245 : 0x5865F2)
            .setAuthor({ name: `Server reputation for ${targetUser.tag}`, iconURL: targetUser.displayAvatarURL() })
            .setDescription(`Reputation in **${interaction.guild.name ?? 'this server'}** only. Other servers have separate records.`)
            .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
            .addFields(
                { name: 'Trust Status', value: flagged ? '🚩 Flagged by a moderator — new deals are blocked' : 'No active scam flag', inline: false },
                { name: 'Rank', value: `${rank.emoji} **${rank.label}**`, inline: true },
                { name: 'Earned Trust Points', value: `${reputation.earned_points}`, inline: true },
                { name: 'Active Rank Score', value: `${reputation.trust_score}`, inline: true },
                { name: 'Admin Rank Override', value: override == null ? 'None — rank uses earned points' : `${override} points (manual override; earned points are preserved)`, inline: false },
                { name: 'Rank Progress', value: rankProgress, inline: true },
                { name: 'Successful Deals', value: `${reputation.successful_deals}`, inline: true },
                { name: 'Unique Trading Partners', value: `${reputation.unique_partners}`, inline: true },
                { name: 'Failed Deals', value: `${reputation.failed_deals}`, inline: true },
                { name: 'Recorded Flag Decisions', value: `${reputation.scam_flag_count}`, inline: true },
                { name: 'Discord Account Age', value: formatDuration(accountAgeDays), inline: true },
                { name: 'Joined This Server', value: joinedServerText, inline: true },
            )
            .setFooter({ text: 'Server-specific reputation • Points reflect activity, not payment verification' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    },
};
