/**
 * Test helper — isolated SQLite database lifecycle.
 *
 * Each test run gets a unique temp directory. Between tests within
 * a suite, `resetTestDb()` clears all rows without re-initializing.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  initializeDatabase,
  closeDatabase,
  getDb,
  stopAutoSave,
} from "../features/01-claude-dialogue/db/connection.js";

let testDataDir = "";

/** Create a temp directory and initialize the DB. Returns the data dir path. */
export async function setupTestDb(): Promise<string> {
  testDataDir = path.join(
    os.tmpdir(),
    `wechat-claude-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(testDataDir, { recursive: true });
  await initializeDatabase(testDataDir);
  return testDataDir;
}

/** Save + close the DB, remove the temp directory. */
export function teardownTestDb(): void {
  stopAutoSave();
  try {
    closeDatabase();
  } catch {
    /* ignore */
  }
  if (testDataDir && fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

/** Delete all rows from all tables (keep schema intact). Useful between tests. */
export function resetTestDb(): void {
  const d = getDb();
  const tables = [
    "scheduled_task_drafts",
    "scheduled_tasks",
    "message_text_index",
    "conversations",
    "turns",
    "sessions",
    "users",
    "schema_migrations",
  ];
  // Disable FK checks temporarily so we can delete in any order
  d.run("PRAGMA foreign_keys = OFF");
  for (const table of tables) {
    d.run(`DELETE FROM ${table}`);
  }
  d.run("PRAGMA foreign_keys = ON");
}

/** Return a workspace base path inside the test temp dir. */
export function getTestWorkspaceBase(): string {
  if (!testDataDir) {
    throw new Error("setupTestDb() must be called before getTestWorkspaceBase()");
  }
  const dir = path.join(testDataDir, "workspaces");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Expose the temp dir for assertions. */
export function getTestDataDir(): string {
  return testDataDir;
}
