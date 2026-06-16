CREATE TABLE IF NOT EXISTS message_text_index (
    msg_id           TEXT    PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    session_id       TEXT    REFERENCES sessions(id) ON DELETE SET NULL,
    from_user_id     TEXT,
    item_type        TEXT,
    file_name        TEXT,
    media_key        TEXT,
    text_content     TEXT    NOT NULL,
    created_at       TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_message_text_index_user_time
    ON message_text_index(user_id, created_at);
