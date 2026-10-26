const { downloadTranscript } = require('../../commands/escrow/transcript');

module.exports = {
    id: 'deals_transcript_',
    async execute(interaction) {
        return downloadTranscript(interaction, interaction.customId.slice(this.id.length));
    },
};
