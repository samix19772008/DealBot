CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id          TEXT NOT NULL UNIQUE,
    username            TEXT NOT NULL,
    account_created_at  DATETIME NOT NULL,
    trust_score         INTEGER NOT NULL DEFAULT 0,
    successful_deals    INTEGER NOT NULL DEFAULT 0,
    failed_deals        INTEGER NOT NULL DEFAULT 0,
    is_scammer          BOOLEAN NOT NULL DEFAULT 0,
    scam_flag_count     INTEGER NOT NULL DEFAULT 0,
    is_vouched          BOOLEAN NOT NULL DEFAULT 0,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_trust_score ON users(trust_score);

CREATE TABLE IF NOT EXISTS escrow_transactions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_uuid    TEXT NOT NULL UNIQUE,
    guild_id            TEXT NOT NULL,
    channel_id          TEXT,

    buyer_id            INTEGER NOT NULL REFERENCES users(id),
    seller_id           INTEGER NOT NULL REFERENCES users(id),

    item_description    TEXT NOT NULL,
    item_type           TEXT NOT NULL DEFAULT 'digital'
                            CHECK (item_type IN ('digital', 'account', 'currency', 'service', 'other')),
    vault_data          TEXT,
    vault_locked        BOOLEAN NOT NULL DEFAULT 1,

    amount              DECIMAL(12,2) NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'USD',
    payment_unit        TEXT CHECK (payment_unit IN ('each', 'stacks')),

    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'pending', 'awaiting_payment', 'funded',
                                'delivered', 'completed', 'disputed',
                                'refunded', 'cancelled'
                            )),

    dispute_reason      TEXT,
    handled_by          INTEGER REFERENCES users(id),

    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    buyer_close_approved   BOOLEAN NOT NULL DEFAULT 0,
    seller_close_approved  BOOLEAN NOT NULL DEFAULT 0,
    completed_at        DATETIME
);

CREATE INDEX IF NOT EXISTS idx_escrow_buyer ON escrow_transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_escrow_seller ON escrow_transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_escrow_status ON escrow_transactions(status);
CREATE INDEX IF NOT EXISTS idx_escrow_guild ON escrow_transactions(guild_id);
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id            TEXT PRIMARY KEY,
    moderator_role_id   TEXT,
    hub_channel_id      TEXT,
    language            TEXT NOT NULL DEFAULT 'en',
    bronze_role_id      TEXT,
    silver_role_id      TEXT,
    gold_role_id        TEXT,
    platinum_role_id    TEXT,
    diamond_role_id     TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS escrow_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    escrow_id           INTEGER NOT NULL REFERENCES escrow_transactions(id),
    event_type          TEXT NOT NULL,
    from_status         TEXT,
    to_status           TEXT,
    actor_discord_id    TEXT,
    reason              TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_escrow_events_escrow ON escrow_events(escrow_id, id);


CREATE TABLE IF NOT EXISTS escrow_thread_closures (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    escrow_id           INTEGER NOT NULL REFERENCES escrow_transactions(id) ON DELETE CASCADE,
    actor_discord_id    TEXT,
    actor_name          TEXT,
    kind                TEXT NOT NULL CHECK (kind IN ('participant', 'moderator', 'untracked')),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'archived', 'failed')),
    requested_at        DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    archive_timestamp   INTEGER,
    UNIQUE (escrow_id, archive_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_thread_closures_pending ON escrow_thread_closures(escrow_id, status, id);

CREATE TABLE IF NOT EXISTS guild_user_profiles (
    guild_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    earned_points INTEGER NOT NULL DEFAULT 0 CHECK (earned_points >= 0),
    successful_deals INTEGER NOT NULL DEFAULT 0 CHECK (successful_deals >= 0),
    failed_deals INTEGER NOT NULL DEFAULT 0 CHECK (failed_deals >= 0),
    is_scammer INTEGER NOT NULL DEFAULT 0 CHECK (is_scammer IN (0, 1)),
    scam_flag_count INTEGER NOT NULL DEFAULT 0 CHECK (scam_flag_count >= 0),
    rank_override_points INTEGER CHECK (rank_override_points IS NULL OR rank_override_points >= 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS escrow_reward_ledger (
    escrow_id INTEGER PRIMARY KEY REFERENCES escrow_transactions(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair_low_user_id INTEGER NOT NULL,
    pair_high_user_id INTEGER NOT NULL,
    awarded_points INTEGER NOT NULL CHECK (awarded_points IN (0, 5)),
    completed_at DATETIME,
    source TEXT NOT NULL CHECK (source IN ('completion', 'backfill'))
);
CREATE INDEX IF NOT EXISTS idx_reward_pair_time ON escrow_reward_ledger
    (guild_id, pair_low_user_id, pair_high_user_id, completed_at);
CREATE TABLE IF NOT EXISTS guild_scam_flag_ledger (
    event_id INTEGER PRIMARY KEY REFERENCES escrow_events(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    escrow_id INTEGER NOT NULL REFERENCES escrow_transactions(id) ON DELETE CASCADE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS guild_rank_override_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_discord_id TEXT NOT NULL,
    old_override_points INTEGER,
    new_override_points INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS guild_flag_review_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_discord_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    old_is_scammer INTEGER NOT NULL,
    new_is_scammer INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
