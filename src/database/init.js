const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'escrow.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true, mode: 0o700 });
const db = new Database(DB_PATH);
function configureDatabase() {
    if (DB_PATH !== ':memory:') fs.chmodSync(path.resolve(DB_PATH), 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (DB_PATH !== ':memory:') {
        for (const suffix of ['-wal', '-shm']) {
            const sidecar = `${path.resolve(DB_PATH)}${suffix}`;
            try { fs.chmodSync(sidecar, 0o600); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
}

/** Apply only additive changes so existing deals and server settings survive upgrades. */
function initDatabase() {
    db.transaction(() => {
        db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
        const additions = {
            guild_settings: {
                hub_channel_id: 'TEXT',
                language: "TEXT NOT NULL DEFAULT 'en'",
                thread_cleanup_minutes: 'INTEGER NOT NULL DEFAULT 30',
                bronze_role_id: 'TEXT',
                silver_role_id: 'TEXT',
                gold_role_id: 'TEXT',
                platinum_role_id: 'TEXT',
                diamond_role_id: 'TEXT',
            },
            escrow_transactions: {
                payment_unit: "TEXT CHECK (payment_unit IN ('each', 'stacks'))",
                buyer_close_approved: 'BOOLEAN NOT NULL DEFAULT 0',
                seller_close_approved: 'BOOLEAN NOT NULL DEFAULT 0',
            },
            listing_request_sessions: {
                source_content: 'TEXT',
            },
            escrow_listing_terms: {
                source_content: 'TEXT',
                product_key: 'TEXT',
                bundle_quantity: 'INTEGER NOT NULL DEFAULT 1',
                bundle_unit: 'TEXT',
                advertised_stock: 'INTEGER',
            },
        };
        for (const [table, columns] of Object.entries(additions)) {
            const present = new Set(db.pragma(`table_info(${table})`).map(column => column.name));
            for (const [name, definition] of Object.entries(columns)) {
                if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
            }
        }
        // English is now the sole bot language, including servers configured before this release.
        db.prepare("UPDATE guild_settings SET language = 'en' WHERE language IS NULL OR language != 'en'").run();
        require('./reputationRepository').backfillGuildReputation(db);
    }).immediate();
    return db;
}

// Repositories prepare statements at import time. Initialize before they can be imported.
try {
    configureDatabase();
    initDatabase();
} catch (error) {
    try { if (db.open) db.close(); }
    catch { /* Preserve the original initialization error. */ }
    throw error;
}
module.exports = { db, initDatabase, DB_PATH };
