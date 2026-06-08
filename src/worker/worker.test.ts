import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { ZamaSDK } from "@zama-fhe/sdk";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import type { Db } from "../db/connection.js";
import { insertTransfer } from "../db/transfers.js";
import { enqueueDecryptJob } from "../db/queue.js";
import { startWorker } from "./worker.js";

const { DelegationNotFoundError, DelegationNotPropagatedError } = vi.hoisted(
  () => {
    class DelegationNotFoundError extends Error {
      constructor() {
        super("Delegation not found");
        this.name = "DelegationNotFoundError";
      }
    }
    class DelegationNotPropagatedError extends Error {
      constructor() {
        super("Delegation not propagated");
        this.name = "DelegationNotPropagatedError";
      }
    }
    return { DelegationNotFoundError, DelegationNotPropagatedError };
  },
);

vi.mock("@zama-fhe/sdk", () => ({
  DelegationNotFoundError,
  DelegationNotPropagatedError,
}));

function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db as unknown as Db;
}

function makeMockSdk(fromResult: unknown, toResult?: unknown): ZamaSDK {
  let callCount = 0;
  return {
    decryption: {
      delegatedDecrypt: vi.fn().mockImplementation(() => {
        const result = callCount === 0 ? fromResult : (toResult ?? fromResult);
        callCount++;
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result);
      }),
    } as unknown as ZamaSDK["decryption"],
  } as ZamaSDK;
}

describe("startWorker", () => {
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

    enqueueDecryptJob(db, transferId, "0xenc123", "0xcontract");
  });

  it("decrypts via delegatedDecrypt with from_address", async () => {
    const sdk = makeMockSdk({ "0xenc123": 1000000n });
    const stopWorker = startWorker(db as Db, sdk);

    await new Promise((r) => setTimeout(r, 300));
    stopWorker();

    const row = db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transferId))
      .get()!;
    expect(row.decrypt_status).toBe("decrypted");
    expect(row.cleartext_amount).toBe(1000000);

    const queueRemaining = db.select().from(schema.decryptQueue).all();
    expect(queueRemaining).toHaveLength(0);
  });

  it("falls back to to_address when from delegation not found", async () => {
    const sdk = makeMockSdk(new DelegationNotFoundError(), {
      "0xenc123": 500000n,
    });
    const stopWorker = startWorker(db as Db, sdk);

    await new Promise((r) => setTimeout(r, 300));
    stopWorker();

    const row = db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transferId))
      .get()!;
    expect(row.decrypt_status).toBe("decrypted");
    expect(row.cleartext_amount).toBe(500000);

    const queueRemaining = db.select().from(schema.decryptQueue).all();
    expect(queueRemaining).toHaveLength(0);
  });

  it("sets no_rights when neither party delegated", async () => {
    const sdk = makeMockSdk(
      new DelegationNotFoundError(),
      new DelegationNotFoundError(),
    );
    const stopWorker = startWorker(db as Db, sdk);

    await new Promise((r) => setTimeout(r, 300));
    stopWorker();

    const row = db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, transferId))
      .get()!;
    expect(row.decrypt_status).toBe("no_rights");

    const queueRemaining = db.select().from(schema.decryptQueue).all();
    expect(queueRemaining).toHaveLength(0);
  });

  it("requeues on transient error from from_address", async () => {
    const sdk = makeMockSdk(new Error("Relayer timeout"));
    const stopWorker = startWorker(db as Db, sdk);

    await new Promise((r) => setTimeout(r, 300));
    stopWorker();

    const queue = db.select().from(schema.decryptQueue).all();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.attempts).toBe(1);
    expect(queue[0]!.last_error).toBe("Relayer timeout");
    expect(queue[0]!.locked_at).toBeNull();
  });
});
