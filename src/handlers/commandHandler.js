const fs = require('fs');
const path = require('path');

function loadCommands(client) {
    client.commands = new Map();
    const commandsPath = path.join(__dirname, '..', 'commands');
    const commandFolders = fs.readdirSync(commandsPath);

    for (const folder of commandFolders) {
        const folderPath = path.join(commandsPath, folder);
        const commandFiles = fs
            .readdirSync(folderPath)
            .filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            const filePath = path.join(folderPath, file);
            const command = require(filePath);

            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
                if (command.registered !== false) console.log(`[COMMAND LOADED] /${command.data.name}`);
            } else {
                console.warn(`[WARNING] ${filePath} is missing "data" or "execute".`);
            }
        }
    }
}

module.exports = { loadCommands };
