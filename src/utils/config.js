function requireConfiguration(names, values = process.env) {
    const missing = names.filter(name => !values[name]?.trim());
    if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}. Add it to .env using .env.example.`);
    for (const name of ['CLIENT_ID', 'GUILD_ID'].filter(name => names.includes(name))) {
        if (!/^\d{17,20}$/.test(values[name].trim())) throw new Error(`${name} must be a Discord numeric ID.`);
    }
}

module.exports = { requireConfiguration };
