// Discord handlers and background organization share this lock while awaiting
// channel operations. SQLite transactions provide the persistent state checks.
const processingDeals = new Set();

module.exports = { processingDeals };
