const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOrCreateUser } = require('../../database/userRepository');
const { getRankForScore, RANKS } = require('../../utils/ranks');

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
        .setDescription("View a user's trust record and rank progress")
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
        const rank = getRankForScore(dbUser.trust_score);
        const nextRank = RANKS.find(candidate => candidate.minPoints > dbUser.trust_score);
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

        const flagged = dbUser.is_scammer === 1;
        const rankProgress = nextRank
            ? `${Math.max(0, nextRank.minPoints - dbUser.trust_score)} points to ${nextRank.label}`
            : 'Highest rank reached';
        const embed = new EmbedBuilder()
            .setColor(flagged ? 0xED4245 : 0x5865F2)
            .setAuthor({ name: `Trust profile for ${targetUser.tag}`, iconURL: targetUser.displayAvatarURL() })
            .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
            .addFields(
                { name: 'Trust Status', value: flagged ? '🚩 Flagged by a moderator — new deals are blocked' : 'No active scam flag', inline: false },
                { name: 'Rank', value: `${rank.emoji} **${rank.label}**`, inline: true },
                { name: 'Trust Points', value: `${dbUser.trust_score}`, inline: true },
                { name: 'Rank Progress', value: rankProgress, inline: true },
                { name: 'Successful Deals', value: `${dbUser.successful_deals}`, inline: true },
                { name: 'Failed Deals', value: `${dbUser.failed_deals}`, inline: true },
                { name: 'Moderator Scam Flags', value: `${dbUser.scam_flag_count}`, inline: true },
                { name: 'Discord Account Age', value: formatDuration(accountAgeDays), inline: true },
                { name: 'Joined This Server', value: joinedServerText, inline: true },
            )
            .setFooter({ text: 'Cross-server activity record • Trust points do not guarantee a safe trade' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    },
};
