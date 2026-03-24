const { query } = require("./db");

const statements = [
  `
    CREATE TABLE IF NOT EXISTS keys (
      key_id TEXT PRIMARY KEY,
      expires BIGINT NULL,
      hwid TEXT NULL,
      activated_at TIMESTAMPTZ NULL,
      paused BOOLEAN NOT NULL DEFAULT FALSE,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      shared BOOLEAN NOT NULL DEFAULT FALSE,
      max_uses INTEGER NOT NULL DEFAULT 0,
      jumpscare BOOLEAN NOT NULL DEFAULT FALSE,
      last_hwid TEXT NULL,
      last_ip TEXT NULL,
      last_username TEXT NULL,
      last_server TEXT NULL,
      last_server_id TEXT NULL,
      last_seen_at BIGINT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS blacklist (
      key_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      key_id TEXT NOT NULL REFERENCES keys(key_id) ON DELETE CASCADE,
      expires BIGINT NOT NULL,
      hwid TEXT NOT NULL,
      request_secret TEXT NOT NULL,
      ip_address TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_sessions_token_hwid
    ON sessions(token, hwid)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_sessions_key_hwid
    ON sessions(key_id, hwid)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_sessions_key_expires
    ON sessions(key_id, expires)
  `,
  `
    CREATE TABLE IF NOT EXISTS presence (
      session_id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL REFERENCES keys(key_id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      server TEXT NOT NULL,
      server_id TEXT NULL,
      last_seen BIGINT NOT NULL,
      frozen BOOLEAN NOT NULL DEFAULT FALSE,
      blinded BOOLEAN NOT NULL DEFAULT FALSE,
      admin_message TEXT NULL,
      player_x DOUBLE PRECISION NOT NULL DEFAULT 0,
      player_y DOUBLE PRECISION NOT NULL DEFAULT 0
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_presence_server_id_last_seen
    ON presence(server_id, last_seen)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_presence_key_id
    ON presence(key_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_presence_last_seen
    ON presence(last_seen)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_presence_server_last_seen
    ON presence(server, last_seen)
  `,
  `
    CREATE TABLE IF NOT EXISTS chat (
      id BIGSERIAL PRIMARY KEY,
      sender_key TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      server TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp BIGINT NOT NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_chat_timestamp
    ON chat(timestamp)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_chat_sender_timestamp
    ON chat(sender_key, timestamp DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_chat_server_timestamp
    ON chat(server, timestamp DESC)
  `,
  `
    CREATE TABLE IF NOT EXISTS key_activations (
      key_id TEXT NOT NULL REFERENCES keys(key_id) ON DELETE CASCADE,
      hwid TEXT NOT NULL,
      first_seen BIGINT,
      last_seen BIGINT,
      PRIMARY KEY (key_id, hwid)
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_key_activations_key
    ON key_activations(key_id)
  `,
  `
    CREATE TABLE IF NOT EXISTS kicked_clients (
      key_id TEXT NOT NULL,
      hwid TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      reason TEXT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (key_id, hwid)
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_kicked_clients_expires
    ON kicked_clients(expires_at)
  `
];

async function ensureSchema() {
  for (const statement of statements) {
    await query(statement);
  }
}

module.exports = {
  ensureSchema
};
