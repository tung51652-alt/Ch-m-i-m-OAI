PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chat_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  claimed_session_id TEXT UNIQUE,
  claimed_at TEXT,
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  ticket_id INTEGER,
  token_limit INTEGER NOT NULL CHECK (token_limit > 0),
  used_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight IN (0, 1)),
  in_flight_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES chat_tickets(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires_at ON chat_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_chat_tickets_expires_at ON chat_tickets(expires_at);
