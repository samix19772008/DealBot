const fs = require('fs');
const path = require('path');

function loadEvents(client) {
    client.dealBotEventTasks ??= new Set();
    const eventsPath = path.join(__dirname, '..', 'events');
    for (const file of fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'))) {
        const event = require(path.join(eventsPath, file));
        const listener = (...args) => {
            if (client.dealBotStopping && event.name !== 'interactionCreate') return;
            const task = Promise.resolve().then(() => {
                if (client.dealBotStopping && event.name !== 'interactionCreate') return;
                return event.execute(...args, client);
            }).catch(error => {
                console.error(`[EVENT] ${event.name} failed:`, error.code ?? error.name);
            }).finally(() => {
                client.dealBotEventTasks.delete(task);
            });
            client.dealBotEventTasks.add(task);
        };
        if (event.once) client.once(event.name, listener);
        else client.on(event.name, listener);
        console.log(`[EVENT LOADED] ${event.name}`);
    }
}

async function drainClientEvents(client) {
    while (client.dealBotEventTasks?.size) {
        await Promise.allSettled([...client.dealBotEventTasks]);
    }
}

module.exports = { loadEvents, drainClientEvents };
