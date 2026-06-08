import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "data", "indexer.db");

let db: Database.Database | null = null;

export function initDb(dbPath = DB_PATH): Database.Database {
  if (db) return db;

  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash           TEXT    NOT NULL,
      log_index         INTEGER NOT NULL,
      block_number      INTEGER NOT NULL,
      block_timestamp   INTEGER NOT NULL,
      event_type        TEXT    NOT NULL CHECK(event_type IN ('transfer', 'shield', 'unshield')),
      from_address      TEXT    NOT NULL,
      to_address        TEXT    NOT NULL,
      encrypted_handle  TEXT,
      cleartext_amount  INTEGER,
      decrypt_status    TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(decrypt_status IN ('plain', 'pending', 'decrypted', 'no_rights')),
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tx_hash, log_index)
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_address);
    CREATE INDEX IF NOT EXISTS idx_transfers_to   ON transfers(to_address);
    CREATE INDEX IF NOT EXISTS idx_transfers_block ON transfers(block_number);

    CREATE TABLE IF NOT EXISTS indexer_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export type Db = Database.Database;
