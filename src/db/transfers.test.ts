import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Db } from "./connection.js";
import {
  insertTransfer,
  getAllTransfers,
  getTransfersByAddress,
} from "./transfers.js";
import {
  getLastIndexedBlock,
  setLastIndexedBlock,
  getChainHeadBlock,
  setChainHeadBlock,
} from "./state.js";

function createTestDb(): Db {
  const sqlite = new Database(":memory:");
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
    CREATE TABLE indexer_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

// ─────────────────────────────────────────────
// transfers
// ─────────────────────────────────────────────

describe("insertTransfer", () => {
  it("inserts a transfer and auto-increments id", () => {
    insertTransfer(db, {
      txHash: "0xaaa",
      logIndex: 0,
      blockNumber: 100n,
      blockTimestamp: 1000,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    });

    const all = getAllTransfers(db, 1, 10);
    expect(all.total).toBe(1);
    expect(all.rows[0]!.tx_hash).toBe("0xaaa");
  });

  it("does not insert duplicate tx_hash + log_index", () => {
    insertTransfer(db, {
      txHash: "0xdup",
      logIndex: 0,
      blockNumber: 100n,
      blockTimestamp: 1000,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: null,
    });

    insertTransfer(db, {
      txHash: "0xdup",
      logIndex: 0,
      blockNumber: 200n,
      blockTimestamp: 2000,
      eventType: "transfer",
      from: "0xfrom2",
      to: "0xto2",
      encryptedHandle: null,
    });

    const all = getAllTransfers(db, 1, 10);
    expect(all.total).toBe(1);
    expect(all.rows[0]!.block_number).toBe(100);
  });
});

describe("getAllTransfers", () => {
  it("returns empty result when no transfers exist", () => {
    const result = getAllTransfers(db, 1, 10);
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it("paginates correctly", () => {
    for (let i = 1; i <= 5; i++) {
      insertTransfer(db, {
        txHash: `0x${i}`,
        logIndex: 0,
        blockNumber: BigInt(i),
        blockTimestamp: i * 100,
        eventType: "transfer",
        from: "0xfrom",
        to: "0xto",
        encryptedHandle: null,
      });
    }

    const page1 = getAllTransfers(db, 1, 2);
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page3 = getAllTransfers(db, 3, 2);
    expect(page3.rows).toHaveLength(1);
    expect(page3.total).toBe(5);
  });

  it("orders by block_number DESC", () => {
    insertTransfer(db, {
      txHash: "0x1",
      logIndex: 0,
      blockNumber: 10n,
      blockTimestamp: 100,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: null,
    });
    insertTransfer(db, {
      txHash: "0x2",
      logIndex: 0,
      blockNumber: 20n,
      blockTimestamp: 200,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: null,
    });

    const result = getAllTransfers(db, 1, 10);
    expect(result.rows[0]!.block_number).toBe(20);
    expect(result.rows[1]!.block_number).toBe(10);
  });
});

describe("getTransfersByAddress", () => {
  it("finds transfers by from_address", () => {
    insertTransfer(db, {
      txHash: "0x1",
      logIndex: 0,
      blockNumber: 1n,
      blockTimestamp: 100,
      eventType: "transfer",
      from: "0xalice",
      to: "0xbob",
      encryptedHandle: null,
    });

    const result = getTransfersByAddress(db, "0xalice", 1, 10);
    expect(result.total).toBe(1);
  });

  it("finds transfers by to_address", () => {
    insertTransfer(db, {
      txHash: "0x1",
      logIndex: 0,
      blockNumber: 1n,
      blockTimestamp: 100,
      eventType: "transfer",
      from: "0xalice",
      to: "0xbob",
      encryptedHandle: null,
    });

    const result = getTransfersByAddress(db, "0xbob", 1, 10);
    expect(result.total).toBe(1);
  });

  it("returns empty for unknown address", () => {
    insertTransfer(db, {
      txHash: "0x1",
      logIndex: 0,
      blockNumber: 1n,
      blockTimestamp: 100,
      eventType: "transfer",
      from: "0xalice",
      to: "0xbob",
      encryptedHandle: null,
    });

    const result = getTransfersByAddress(db, "0xcharlie", 1, 10);
    expect(result.total).toBe(0);
  });
});

// ─────────────────────────────────────────────
// state
// ─────────────────────────────────────────────

describe("indexerState", () => {
  it("returns null when no state stored", () => {
    expect(getLastIndexedBlock(db)).toBeNull();
    expect(getChainHeadBlock(db)).toBeNull();
  });

  it("round-trips a value", () => {
    setLastIndexedBlock(db, 42);
    expect(getLastIndexedBlock(db)).toBe(42);
  });

  it("overwrites an existing key", () => {
    setLastIndexedBlock(db, 100);
    setLastIndexedBlock(db, 200);
    expect(getLastIndexedBlock(db)).toBe(200);
  });

  it("stores different keys independently", () => {
    setLastIndexedBlock(db, 10);
    setChainHeadBlock(db, 20);
    expect(getLastIndexedBlock(db)).toBe(10);
    expect(getChainHeadBlock(db)).toBe(20);
  });
});
