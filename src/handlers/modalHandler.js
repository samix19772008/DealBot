const fs = require('fs');
const path = require('path');

function loadModals(client) {
    client.modals = [];
    const modalsPath = path.join(__dirname, '..', 'interactions', 'modals');
    const modalFiles = fs.readdirSync(modalsPath).filter(file => file.endsWith('.js'));

    for (const file of modalFiles) {
        const filePath = path.join(modalsPath, file);
        const modal = require(filePath);

        if ('id' in modal && 'execute' in modal) {
            client.modals.push(modal);
            console.log(`[MODAL LOADED] prefix "${modal.id}"`);
        } else {
            console.warn(`[WARNING] ${filePath} is missing "id" or "execute".`);
        }
    }
}

module.exports = { loadModals };