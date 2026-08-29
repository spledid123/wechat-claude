/**
 * Database connection and migration management.
 *
 * Uses sql.js (SQLite compiled to WASM) — zero native dependencies.
 * The WASM file is bundled with the sql.js npm package and loaded automatically.
 */

import { getRootLogger } from "../../../runtime/logger.js";
import initSqlJs, {
  type Database as SqlJsDatabase,
  type SqlJsStatic,
} from "sql.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Resolve the bundled sql.js WASM file. Without this, `initSqlJs()` tries to
 * locate `sql-wasm.wasm` relative to the module dir, which fails once the app
 * is packed into an asar archive. `asarUnpack` (see package.json build config)
 * keeps the file on disk; Electron transparently redirects the asar path to the
 * unpacked copy, so passing the resolved path here works in both dev and prod.
 */
function locateSqlWasm(file: string): string {
  try {
    return require.resolve(`sql.js/dist/${file}`);
  } catch {
    return file;
  }
}

// --------------- module-level state ---------------
let SQL: SqlJsStatic | null = null;
let db: SqlJsDatabase | null = null;
let dbPath = "";
let saveInterval: NodeJS.Timeout | null = null;

// --------------- public API ---------------

export function getDb(): SqlJsDatabase {
  if (!db) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return db;
}

export async function initializeDatabase(
  dataDir: string,
): Promise<SqlJsDatabase> {
  dbPath = path.join(dataDir, "relay.sqlite");

  // Load sql.js WASM (cached after first call)
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: locateSqlWasm });
  }

  // Open existing or create new
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON");

  runMigrations();

  return db;
}

export function saveDatabase(): void {
  if (!db || !dbPath) return;
  const data = db.export();
  // Atomic write: serialize to a temp file, fsync, then rename over the target.
  // A crash mid-write leaves the original DB intact instead of a truncated,
  // unopenable file ("file is not a database").
  const tmpPath = `${dbPath}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, Buffer.from(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, dbPath);
}

export function closeDatabase(): void {
  stopAutoSave();
  if (db) {
    try {
      saveDatabase();
    } catch {
      /* best effort */
    }
    db.close();
    db = null;
  }
}

export function startAutoSave(intervalMs = 30_000): void {
  if (saveInterval) return;
  saveInterval = setInterval(() => {
    try {
      saveDatabase();
    } catch {
      /* ignore — will retry next interval */
    }
  }, intervalMs);
}

export function stopAutoSave(): void {
  if (saveInterval) {
    clearInterval(saveInterval);
    saveInterval = null;
  }
}

// --------------- query helpers ---------------

export function queryAll<T = Record<string, unknown>>(
  sql: string,
  params: import("sql.js").SqlValue[] = [],
): T[] {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params.length > 0) {
    stmt.bind(params);
  }

  const results: T[] = [];
  try {
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as T);
    }
  } finally {
    stmt.free();
  }
  return results;
}

export function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: import("sql.js").SqlValue[] = [],
): T | null {
  const rows = queryAll<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export function execute(
  sql: string,
  params: import("sql.js").SqlValue[] = [],
): { changes: number } {
  const d = getDb();
  d.run(sql, params);
  return { changes: d.getRowsModified() };
}

export function getLastInsertId(): number {
  const d = getDb();
  const result = d.exec("SELECT last_insert_rowid()");
  if (
    result.length > 0 &&
    result[0].values &&
    result[0].values.length > 0
  ) {
    return result[0].values[0][0] as number;
  }
  return 0;
}

// --------------- migrations ---------------

function findMigrationsDir(): string {
  // In the packaged app, this file is compiled under:
  //   dist/src/features/01-claude-dialogue/db/
  // Migrations live next to this file in ./migrations/
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(currentDir, "migrations");
  if (fs.existsSync(candidate)) return candidate;
  return candidate; // fallback — let it fail with a clear error
}

function runMigrations(): void {
  if (!db) return;

  // Ensure schema_migrations table exists (bootstrapping)
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = findMigrationsDir();
  if (!fs.existsSync(migrationsDir)) {
    getRootLogger().warn(`Migrations directory not found: ${migrationsDir}`);
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Build set of already-applied versions
  const applied = new Set<number>();
  const rows = db.exec("SELECT version FROM schema_migrations");
  if (rows.length > 0 && rows[0].values) {
    for (const row of rows[0].values) {
      applied.add(row[0] as number);
    }
  }

  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match) continue;
    const version = parseInt(match[1], 10);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    // Wrap each migration + its version bump in a single transaction so a
    // partially-applied migration (e.g. 004 rebuilds a table) rolls back
    // cleanly instead of leaving orphan tables that break the next startup.
    db.run("BEGIN");
    try {
      db.run(sql);
      db.run(
        "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)",
        [version, file],
      );
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw new Error(
        `Migration ${file} failed: ${(err as Error).message}`,
      );
    }
  }

  ensureMessageTextIndexColumns();
}

function ensureMessageTextIndexColumns(): void {
  if (!db) return;

  const tableExists = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='message_text_index'",
  );
  if (tableExists.length === 0 || !tableExists[0].values?.length) {
    return;
  }

  const cols = new Set<string>();
  const pragma = db.exec("PRAGMA table_info('message_text_index')");
  if (pragma.length > 0 && pragma[0].values) {
    for (const row of pragma[0].values) {
      cols.add(String(row[1]));
    }
  }

  if (!cols.has("file_name")) {
    db.run("ALTER TABLE message_text_index ADD COLUMN file_name TEXT");
  }
  if (!cols.has("media_key")) {
    db.run("ALTER TABLE message_text_index ADD COLUMN media_key TEXT");
  }

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_message_text_index_user_file ON message_text_index(user_id, file_name, created_at)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_message_text_index_user_media ON message_text_index(user_id, media_key, created_at)",
  );
}
