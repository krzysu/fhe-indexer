import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema.js";

/**
 * SQLite file location, resolved against the process working directory.
 * Overrideable via the optional `dbPath` arg (used by the e2e test which
 * uses `:memory:`).
 */
const DB_PATH = path.resolve(process.cwd(), "data", "indexer.db");

/** Module-level Drizzle handle; one per process. */
let instance: BetterSQLite3Database<typeof schema> | null = null;

/** Underlying better-sqlite3 handle kept around so we can close it cleanly. */
let sqlite: Database.Database | null = null;

/**
 * Opens (or creates) the SQLite DB, enables WAL mode for concurrent
 * readers, turns on foreign keys (needed for `ON DELETE CASCADE`),
 * applies any pending Drizzle migrations, and returns the Drizzle handle.
 * Idempotent: subsequent calls return the existing instance.
 */
export function initDb(dbPath = DB_PATH): BetterSQLite3Database<typeof schema> {
  if (instance) return instance;

  mkdirSync(path.dirname(dbPath), { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  instance = drizzle(sqlite, { schema });

  migrate(instance, { migrationsFolder: "./drizzle" });

  return instance;
}

/**
 * Returns the existing Drizzle handle. Throws if `initDb()` hasn't been
 * called — a defensive guard against module init-order bugs.
 */
export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!instance)
    throw new Error("Database not initialized. Call initDb() first.");
  return instance;
}

/**
 * Closes the underlying SQLite handle and clears the singleton. Called
 * from the SIGINT/SIGTERM shutdown path so the process exits cleanly.
 */
export function closeDb(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    instance = null;
  }
}

export type Db = BetterSQLite3Database<typeof schema>;
