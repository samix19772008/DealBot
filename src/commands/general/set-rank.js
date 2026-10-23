const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getOrCreateUser, setTrustScore } = require('../../database/userRepository');
const { getRankByKey, RANKS } = require('../../utils/ranks');
const { syncMemberRankRole } = require('../../utils/roleSync');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-rank')
        .setDescription('Manually set a member\'s trust rank')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option => option
            .setName('user').setDescription('The member whose trust rank to update').setRequired(true))
        .addStringOption(option => option
            .setName('rank').setDescription('The new trust rank').setRequired(true)
            .addChoices(...RANKS.map(rank => ({ name: `${rank.emoji} ${rank.label}`, value: rank.key })))),

    async execute(interaction) {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only server administrators can manually change trust ranks.', ephemeral: true });
        }
        const targetUser = interaction.options.getUser('user');
        const rank = getRankByKey(interaction.options.getString('rank'));
        if (!rank || !targetUser || targetUser.bot) {
            return interaction.reply({ content: 'Choose a valid member and trust rank.', ephemeral: true });
        }
        const dbUser = getOrCreateUser(targetUser);
        if (dbUser.is_scammer) {
            return interaction.reply({ content: 'A confirmed scam flag must be reviewed separately before this member can receive a trust rank.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        setTrustScore(dbUser.id, rank.minPoints);
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        const synced = member ? await syncMemberRankRole(member, rank.minPoints) : false;
        return interaction.editReply({
            content: `✅ <@${targetUser.id}> now has ${rank.emoji} **${rank.label}** (${rank.minPoints} trust points).${synced ? '' : ' The trust record was saved, but the Discord role could not be synchronized. Check membership, role configuration, and bot permissions.'}`,
            allowedMentions: { parse: [] },
        });
    },
};
