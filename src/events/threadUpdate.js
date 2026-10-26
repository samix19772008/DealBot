const { Events } = require('discord.js');
const { getEscrowByChannelId } = require('../database/escrowRepository');
const { markThreadReopened } = require('../database/transcriptRepository');
const { rescheduleThreadCleanup } = require('../database/threadOrganizationRepository');
const { rescheduleActiveThreadCleanup } = require('../database/activeThreadOrganizationRepository');
const { deliverThreadTranscript, TRANSCRIPT_LIMIT } = require('../services/transcripts');

module.exports = {
    name: Events.ThreadUpdate,
    async execute(oldThread, newThread) {
        if (oldThread.archived && !newThread.archived) {
            const escrow = getEscrowByChannelId(newThread.id);
            if (escrow && newThread.guildId === escrow.guild_id) {
                markThreadReopened(escrow.id);
                rescheduleThreadCleanup(escrow.id);
                rescheduleActiveThreadCleanup(escrow.id);
            }
            return;
        }
        if (oldThread.archived || !newThread.archived) return;
        return deliverThreadTranscript(newThread);
    },
    TRANSCRIPT_LIMIT,
};
