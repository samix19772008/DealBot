const translations = require('../locales/en.json');

// Keep the existing API compatible with pending messages and old guild settings.
const SUPPORTED_LOCALES = ['en'];
function normalizeLocale() { return 'en'; }
function resolveGuildLocale() { return 'en'; }

function t(key, _locale, variables = {}) {
    const value = key.split('.').reduce((entry, part) => entry?.[part], translations);
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, (match, name) => (
        variables[name] === undefined ? match : String(variables[name])
    ));
}

module.exports = { t, normalizeLocale, resolveGuildLocale, SUPPORTED_LOCALES };
