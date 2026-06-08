import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema.js";

const DB_PATH = path.resolve(process.cwd(), "data", "indexer.db");

let instance: BetterSQLite3Database<typeof schema> | null = null;
let sqlite: Database.Database | null = null;

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

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!instance)
    throw new Error("Database not initialized. Call initDb() first.");
  return instance;
}

export function closeDb(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    instance = null;
  }
}

export type Db = BetterSQLite3Database<typeof schema>;
