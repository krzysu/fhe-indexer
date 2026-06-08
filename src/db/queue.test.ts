import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./connection.js";
import {
  enqueueDecryptJob,
  dequeueBatch,
  requeueWithBackoff,
  deleteQueueEntry,
  getPendingOrphanTransfers,
} from "./queue.js";
import { insertTransfer } from "./transfers.js";

function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      encrypted_handle TEXT,
      cleartext_amount INTEGER,
      decrypt_status TEXT DEFAULT 'pending' NOT NULL,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
    CREATE UNIQUE INDEX unq_tx_hash_log_index ON transfers (tx_hash, log_index);
    CREATE TABLE decrypt_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      transfer_id INTEGER NOT NULL UNIQUE,
      encrypted_handle TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      attempts INTEGER DEFAULT 0 NOT NULL,
      max_attempts INTEGER DEFAULT 3 NOT NULL,
      last_error TEXT,
      last_attempted_at TEXT,
      locked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL,
      FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
    );
    CREATE TABLE indexer_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

let db: Db;
let transferId: number;

beforeEach(() => {
  db = createTestDb();
  const result = insertTransfer(db, {
    txHash: "0xaaa",
    logIndex: 0,
    blockNumber: 100n,
    blockTimestamp: 1000,
    eventType: "transfer",
    from: "0xfrom",
    to: "0xto",
    encryptedHandle: "0xenc123",
  });
  transferId = result!;
});

describe("enqueueDecryptJob", () => {
  it("inserts a decrypt job", () => {
    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");

    const jobs = dequeueBatch(db, 10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.transfer_id).toBe(transferId);
    expect(jobs[0]!.encrypted_handle).toBe("0xenc123");
    expect(jobs[0]!.contract_address).toBe("0xcontract");
  });

  it("does not insert duplicate transfer_id", () => {
    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");
    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");

    const jobs = dequeueBatch(db, 10);
    expect(jobs).toHaveLength(1);
  });
});

describe("dequeueBatch", () => {
  it("returns only unlocked jobs", () => {
    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");

    const first = dequeueBatch(db, 10);
    expect(first).toHaveLength(1);

    const second = dequeueBatch(db, 10);
    expect(second).toHaveLength(0);
  });

  it("skips jobs that exhausted max_attempts", () => {
    const result = insertTransfer(db, {
      txHash: "0xbbb",
      logIndex: 0,
      blockNumber: 101n,
      blockTimestamp: 1001,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc456",
    });
    const id = result!;

    db.insert(schema.decryptQueue)
      .values({
        transfer_id: id,
        encrypted_handle: "0xenc456",
        contract_address: "0xcontract",
        attempts: 3,
        max_attempts: 3,
      })
      .run();

    const jobs = dequeueBatch(db, 10);
    expect(jobs).toHaveLength(0);
  });
});

describe("requeueWithBackoff", () => {
  it("increments attempts and clears lock", () => {
    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");
    const jobs = dequeueBatch(db, 10);
    expect(jobs).toHaveLength(1);

    requeueWithBackoff(db, jobs[0]!.id, "test error");

    const ready = dequeueBatch(db, 10);
    expect(ready).toHaveLength(0);

    const all = db.select().from(schema.decryptQueue).all();
    expect(all).toHaveLength(1);
    expect(all[0]!.attempts).toBe(1);
    expect(all[0]!.locked_at).toBeNull();
    expect(all[0]!.last_error).toBe("test error");
  });
});

describe("deleteQueueEntry", () => {
  it("removes a queue entry", () => {
    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");
    const jobs = dequeueBatch(db, 10);
    expect(jobs).toHaveLength(1);

    deleteQueueEntry(db, jobs[0]!.id);

    const remaining = dequeueBatch(db, 10);
    expect(remaining).toHaveLength(0);
  });
});

describe("getPendingOrphanTransfers", () => {
  it("returns pending transfers without a queue entry", () => {
    const orphans = getPendingOrphanTransfers(db);
    expect(orphans).toHaveLength(1);

    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");
    const orphans2 = getPendingOrphanTransfers(db);
    expect(orphans2).toHaveLength(0);
  });

  it("excludes non-pending transfers", () => {
    const result = insertTransfer(db, {
      txHash: "0xbbb",
      logIndex: 0,
      blockNumber: 101n,
      blockTimestamp: 1001,
      eventType: "shield",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: null,
    });
    const id = result!;

    db.update(schema.transfers)
      .set({ decrypt_status: "decrypted" })
      .where(eq(schema.transfers.id, id))
      .run();

    const orphans = getPendingOrphanTransfers(db);
    expect(orphans).toHaveLength(1);
  });
});
