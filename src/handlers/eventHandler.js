const fs = require('fs');
const path = require('path');

function loadEvents(client) {
    const eventsPath = path.join(__dirname, '..', 'events');
    for (const file of fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'))) {
        const event = require(path.join(eventsPath, file));
        const listener = (...args) => {
            Promise.resolve().then(() => event.execute(...args, client)).catch(error => {
                console.error(`[EVENT] ${event.name} failed:`, error.code ?? error.name);
            });
        };
        if (event.once) client.once(event.name, listener);
        else client.on(event.name, listener);
        console.log(`[EVENT LOADED] ${event.name}`);
    }
}

module.exports = { loadEvents };
