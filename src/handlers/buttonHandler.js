const fs = require('fs');
const path = require('path');

function loadButtons(client) {
    client.buttons = [];
    const buttonsPath = path.join(__dirname, '..', 'interactions', 'buttons');
    const buttonFiles = fs.readdirSync(buttonsPath).filter(file => file.endsWith('.js'));

    for (const file of buttonFiles) {
        const filePath = path.join(buttonsPath, file);
        const button = require(filePath);

        if ('id' in button && 'execute' in button) {
            client.buttons.push(button);
            console.log(`[BUTTON LOADED] prefix "${button.id}"`);
        } else {
            console.warn(`[WARNING] ${filePath} is missing "id" or "execute".`);
        }
    }
}

module.exports = { loadButtons };