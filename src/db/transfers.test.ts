import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./connection.js";
import {
  insertTransfer,
  getAllTransfers,
  getTransfersByAddress,
  deleteTransfersAfter,
  updateTransferDecryptStatus,
  getNoRightsTransfers,
  resetTransfersToPending,
} from "./transfers.js";
import {
  getLastIndexedBlock,
  setLastIndexedBlock,
  getChainHeadBlock,
  setChainHeadBlock,
} from "./state.js";

function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db as unknown as Db;
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

  it("returns the inserted row id", () => {
    const id = insertTransfer(db, {
      txHash: "0xbbb",
      logIndex: 0,
      blockNumber: 200n,
      blockTimestamp: 2000,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: null,
    });

    expect(id).toBeGreaterThan(0);
  });

  it("returns undefined for duplicate tx_hash + log_index", () => {
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

    const id = insertTransfer(db, {
      txHash: "0xdup",
      logIndex: 0,
      blockNumber: 200n,
      blockTimestamp: 2000,
      eventType: "transfer",
      from: "0xfrom2",
      to: "0xto2",
      encryptedHandle: null,
    });

    expect(id).toBeUndefined();
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

describe("updateTransferDecryptStatus", () => {
  it("updates decrypt_status and cleartext_amount", () => {
    const id = insertTransfer(db, {
      txHash: "0xdecrypt",
      logIndex: 0,
      blockNumber: 100n,
      blockTimestamp: 1000,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    })!;

    updateTransferDecryptStatus(db, id, "decrypted", 1000000n);

    const row = db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, id))
      .get()!;
    expect(row.decrypt_status).toBe("decrypted");
    expect(row.cleartext_amount).toBe(1000000);
  });

  it("updates decrypt_status without cleartext", () => {
    const id = insertTransfer(db, {
      txHash: "0xnorights",
      logIndex: 0,
      blockNumber: 100n,
      blockTimestamp: 1000,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    })!;

    updateTransferDecryptStatus(db, id, "no_rights");

    const row = db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, id))
      .get()!;
    expect(row.decrypt_status).toBe("no_rights");
    expect(row.cleartext_amount).toBeNull();
  });
});

describe("deleteTransfersAfter", () => {
  it("deletes transfers above the given block number", () => {
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
    insertTransfer(db, {
      txHash: "0x3",
      logIndex: 0,
      blockNumber: 30n,
      blockTimestamp: 300,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: null,
    });

    deleteTransfersAfter(db, 20);

    const remaining = getAllTransfers(db, 1, 100);
    expect(remaining.total).toBe(2); // blocks 10 and 20 (but 20 is not > 20, so kept)
    expect(remaining.rows.map((r) => r.block_number).sort()).toEqual([10, 20]);
  });

  it("cascade-deletes related decrypt_queue entries", () => {
    const id = insertTransfer(db, {
      txHash: "0xqueued",
      logIndex: 0,
      blockNumber: 50n,
      blockTimestamp: 500,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    })!;

    db.insert(schema.decryptQueue)
      .values({
        transfer_id: id,
        encrypted_handle: "0xenc",
        contract_address: "0xcontract",
      })
      .run();

    deleteTransfersAfter(db, 40);

    const queueRemaining = db.select().from(schema.decryptQueue).all();
    expect(queueRemaining).toHaveLength(0);
  });
});

describe("getNoRightsTransfers", () => {
  it("returns empty when no no_rights transfers exist", () => {
    insertTransfer(db, {
      txHash: "0xt1",
      logIndex: 0,
      blockNumber: 10n,
      blockTimestamp: 100,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    });

    expect(getNoRightsTransfers(db)).toHaveLength(0);
  });

  it("returns transfers with decrypt_status=no_rights", () => {
    insertTransfer(db, {
      txHash: "0xt2",
      logIndex: 0,
      blockNumber: 20n,
      blockTimestamp: 200,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    });
    updateTransferDecryptStatus(db, 1, "no_rights");

    const rows = getNoRightsTransfers(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.encrypted_handle).toBe("0xenc");
  });

  it("filters by address when provided", () => {
    insertTransfer(db, {
      txHash: "0xalice",
      logIndex: 0,
      blockNumber: 10n,
      blockTimestamp: 100,
      eventType: "transfer",
      from: "0xAlice",
      to: "0xBob",
      encryptedHandle: "0xenc1",
    });
    insertTransfer(db, {
      txHash: "0xcharlie",
      logIndex: 0,
      blockNumber: 20n,
      blockTimestamp: 200,
      eventType: "transfer",
      from: "0xCharlie",
      to: "0xDave",
      encryptedHandle: "0xenc2",
    });
    updateTransferDecryptStatus(db, 1, "no_rights");
    updateTransferDecryptStatus(db, 2, "no_rights");

    expect(getNoRightsTransfers(db, "0xAlice")).toHaveLength(1);
    expect(getNoRightsTransfers(db, "0xBob")).toHaveLength(1);
    expect(getNoRightsTransfers(db)).toHaveLength(2);
  });

  it("excludes rows with null encrypted_handle", () => {
    insertTransfer(db, {
      txHash: "0xshield",
      logIndex: 0,
      blockNumber: 10n,
      blockTimestamp: 100,
      eventType: "shield",
      from: "0x0000000000000000000000000000000000000000",
      to: "0xAlice",
      encryptedHandle: null,
    });
    updateTransferDecryptStatus(db, 1, "no_rights");

    expect(getNoRightsTransfers(db)).toHaveLength(0);
  });
});

describe("resetTransfersToPending", () => {
  it("does nothing with an empty array", () => {
    expect(() => resetTransfersToPending(db, [])).not.toThrow();
  });

  it("resets multiple transfers back to pending", () => {
    insertTransfer(db, {
      txHash: "0xr1",
      logIndex: 0,
      blockNumber: 10n,
      blockTimestamp: 100,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    });
    insertTransfer(db, {
      txHash: "0xr2",
      logIndex: 0,
      blockNumber: 20n,
      blockTimestamp: 200,
      eventType: "transfer",
      from: "0xfrom",
      to: "0xto",
      encryptedHandle: "0xenc",
    });
    updateTransferDecryptStatus(db, 1, "no_rights");
    updateTransferDecryptStatus(db, 2, "no_rights");

    resetTransfersToPending(db, [1, 2]);

    const remaining = getNoRightsTransfers(db);
    expect(remaining).toHaveLength(0);
  });
});

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
