const { deliverThreadTranscript } = require('../services/transcripts');

module.exports = {
    // A bot-driven REST update can update the SDK cache before its Gateway event.
    // The close utility emits this event so that cache ordering cannot lose a DM.
    name: 'dealThreadArchived',
    async execute(thread, archiveTimestamp) {
        return deliverThreadTranscript(thread, archiveTimestamp);
    },
};
