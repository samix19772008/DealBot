require('dotenv').config({ quiet: true });
const { db, initDatabase, DB_PATH } = require('../src/database/init');
initDatabase();
console.log(`Database schema and additive migrations are ready: ${DB_PATH}`);
db.close();
