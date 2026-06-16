-- Migration 001: Initial schema for Feature 1 (Claude dialogue + records)
-- Tables: users, sessions, conversations, schema_migrations

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wechat_user_id  TEXT    UNIQUE NOT NULL,
    nickname        TEXT,
    first_seen_at   TEXT    DEFAULT (datetime('now')),
    last_active_at  TEXT    DEFAULT (datetime('now')),
    created_at      TEXT    DEFAULT (datetime('now')),
    updated_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT    PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id),
    from_user_id        TEXT    NOT NULL,
    context_token       TEXT,
    claude_session_id   TEXT,
    cwd                 TEXT    NOT NULL,
    status              TEXT    DEFAULT 'active'  CHECK(status IN ('active','closed')),
    summary             TEXT,
    tool_mode           TEXT    DEFAULT 'safe_restricted',
    message_count       INTEGER DEFAULT 0,
    closed_reason       TEXT,
    created_at          TEXT    DEFAULT (datetime('now')),
    last_active_at      TEXT    DEFAULT (datetime('now')),
    closed_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, last_active_at);

CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    seq_in_session  INTEGER NOT NULL,
    direction       TEXT    NOT NULL  CHECK(direction IN ('inbound','outbound')),
    message_type    INTEGER NOT NULL,
    text_content    TEXT,
    file_refs       TEXT,
    context_token   TEXT,
    created_at      TEXT    DEFAULT (datetime('now')),
    UNIQUE(session_id, seq_in_session)
);

CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id, created_at);

CREATE TABLE IF NOT EXISTS message_text_index (
    msg_id           TEXT    PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    session_id       TEXT    REFERENCES sessions(id) ON DELETE SET NULL,
    from_user_id     TEXT,
    item_type        TEXT,
    text_content     TEXT    NOT NULL,
    created_at       TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_message_text_index_user_time
    ON message_text_index(user_id, created_at);

-- Turns table: intermediate buffer for message debouncing (Feature 6).
-- Messages arrive → buffered in turns → merged → processed → archived in conversations.
CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    context_token   TEXT,
    role            TEXT    NOT NULL DEFAULT 'buffered_user',
    normalized_text TEXT,
    raw_payload_json TEXT,
    status          TEXT    DEFAULT 'buffered'  CHECK(status IN ('buffered','merged','discarded')),
    created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_turns_session_status ON turns(session_id, status);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    applied_at  TEXT    DEFAULT (datetime('now'))
);
