const fs = require('fs');
const path = require('path');

function loadSelects(client) {
    client.selects = [];
    const selectsPath = path.join(__dirname, '..', 'interactions', 'selects');
    const selectFiles = fs.readdirSync(selectsPath).filter(file => file.endsWith('.js'));
    for (const file of selectFiles) {
        const handler = require(path.join(selectsPath, file));
        if (typeof handler.id === 'string' && typeof handler.execute === 'function') {
            client.selects.push(handler);
            console.log(`[SELECT LOADED] prefix "${handler.id}"`);
        } else {
            console.warn(`[WARNING] ${file} is missing "id" or "execute".`);
        }
    }
}

module.exports = { loadSelects };
