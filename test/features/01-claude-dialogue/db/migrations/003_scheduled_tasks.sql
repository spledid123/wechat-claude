CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    context_token   TEXT NOT NULL,
    title           TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK(mode IN ('send_text','agent_prompt')),
    payload_text    TEXT NOT NULL,
    schedule_type   TEXT NOT NULL CHECK(schedule_type IN ('once','weekly')),
    run_at          TEXT,
    weekday         INTEGER,
    time_of_day     TEXT,
    timezone        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled','expired')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_run_at     TEXT,
    next_run_at     TEXT NOT NULL,
    expires_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_status
    ON scheduled_tasks(user_id, status, next_run_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON scheduled_tasks(status, next_run_at);

CREATE TABLE IF NOT EXISTS scheduled_task_drafts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    context_token   TEXT NOT NULL,
    title           TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK(mode IN ('send_text','agent_prompt')),
    payload_text    TEXT NOT NULL,
    schedule_type   TEXT NOT NULL CHECK(schedule_type IN ('once','weekly')),
    run_at          TEXT,
    weekday         INTEGER,
    time_of_day     TEXT,
    timezone        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_task_drafts_user
    ON scheduled_task_drafts(user_id, created_at);
