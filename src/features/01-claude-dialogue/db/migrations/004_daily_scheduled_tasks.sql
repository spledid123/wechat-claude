PRAGMA foreign_keys = OFF;

-- Drop any leftover temp tables from a previously interrupted run of this
-- migration so a retry does not fail with "table already exists".
DROP TABLE IF EXISTS scheduled_tasks_new;
DROP TABLE IF EXISTS scheduled_task_drafts_new;

CREATE TABLE scheduled_tasks_new (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    context_token   TEXT NOT NULL,
    title           TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK(mode IN ('send_text','agent_prompt')),
    payload_text    TEXT NOT NULL,
    schedule_type   TEXT NOT NULL CHECK(schedule_type IN ('once','daily','weekly')),
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

INSERT INTO scheduled_tasks_new (
    id, user_id, context_token, title, mode, payload_text, schedule_type,
    run_at, weekday, time_of_day, timezone, status, created_at, updated_at,
    last_run_at, next_run_at, expires_at
)
SELECT
    id, user_id, context_token, title, mode, payload_text, schedule_type,
    run_at, weekday, time_of_day, timezone, status, created_at, updated_at,
    last_run_at, next_run_at, expires_at
FROM scheduled_tasks;

DROP TABLE scheduled_tasks;
ALTER TABLE scheduled_tasks_new RENAME TO scheduled_tasks;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_status
    ON scheduled_tasks(user_id, status, next_run_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON scheduled_tasks(status, next_run_at);

CREATE TABLE scheduled_task_drafts_new (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    context_token   TEXT NOT NULL,
    title           TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK(mode IN ('send_text','agent_prompt')),
    payload_text    TEXT NOT NULL,
    schedule_type   TEXT NOT NULL CHECK(schedule_type IN ('once','daily','weekly')),
    run_at          TEXT,
    weekday         INTEGER,
    time_of_day     TEXT,
    timezone        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL
);

INSERT INTO scheduled_task_drafts_new (
    id, user_id, context_token, title, mode, payload_text, schedule_type,
    run_at, weekday, time_of_day, timezone, created_at, expires_at
)
SELECT
    id, user_id, context_token, title, mode, payload_text, schedule_type,
    run_at, weekday, time_of_day, timezone, created_at, expires_at
FROM scheduled_task_drafts;

DROP TABLE scheduled_task_drafts;
ALTER TABLE scheduled_task_drafts_new RENAME TO scheduled_task_drafts;

CREATE INDEX IF NOT EXISTS idx_scheduled_task_drafts_user
    ON scheduled_task_drafts(user_id, created_at);

PRAGMA foreign_keys = ON;
