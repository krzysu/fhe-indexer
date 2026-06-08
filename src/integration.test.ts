import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { ZamaSDK } from "@zama-fhe/sdk";
import type { Address } from "viem";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./db/schema.js";
import type { Db } from "./db/connection.js";
import { insertTransfer } from "./db/transfers.js";
import { enqueueDecryptJob } from "./db/queue.js";
import {
  updateBalanceForTransfer,
  markTransferDecrypted,
  getBalance,
} from "./db/balances.js";
import { startWorker } from "./worker/worker.js";
import { getFullTransferById } from "./db/transfers.js";

const { DelegationNotFoundError } = vi.hoisted(() => {
  class DelegationNotFoundError extends Error {
    constructor() {
      super("Delegation not found");
      this.name = "DelegationNotFoundError";
    }
  }
  return { DelegationNotFoundError };
});

vi.mock("@zama-fhe/sdk", () => ({
  DelegationNotFoundError,
  DelegationNotPropagatedError: class extends Error {},
}));

function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db as unknown as Db;
}

function makeMockSdk(result: unknown): ZamaSDK {
  return {
    decryption: {
      delegatedDecrypt: vi
        .fn()
        .mockImplementation(() =>
          result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve(result),
        ),
    } as unknown as ZamaSDK["decryption"],
  } as ZamaSDK;
}

const CONTRACT_ADDR = "0x7c5BF43B851c1dff1a4feE8DB225b87f2C223639" as Address;
const FROM_ADDR = "0x1111111111111111111111111111111111111111" as Address;
const TO_ADDR = "0x2222222222222222222222222222222222222222" as Address;

describe("Integration: event → store → decrypt → balance", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("happy path: shield event updates balance immediately", () => {
    const id = insertTransfer(db, {
      txHash: "0xaaa",
      logIndex: 0,
      blockNumber: 100n,
      blockTimestamp: 1000,
      eventType: "shield",
      from: "0x0000000000000000000000000000000000000000",
      to: TO_ADDR,
      encryptedHandle: null,
    });

    const transfer = getFullTransferById(db, id!);
    updateBalanceForTransfer(db, {
      ...transfer!,
      cleartext_amount: 5000000,
      decrypt_status: "plain",
    });

    const balance = getBalance(db, TO_ADDR);
    expect(balance?.cleartext_balance).toBe(5000000);
    expect(balance?.balance_status).toBe("complete");
    expect(balance?.pending_transfers_count).toBe(0);
  });

  it("happy path: transfer event → decrypt → balance updated", async () => {
    const id = insertTransfer(db, {
      txHash: "0xbbb",
      logIndex: 0,
      blockNumber: 200n,
      blockTimestamp: 2000,
      eventType: "transfer",
      from: FROM_ADDR,
      to: TO_ADDR,
      encryptedHandle: "0xenc456",
    });

    const transfer = getFullTransferById(db, id!);
    updateBalanceForTransfer(db, transfer!);

    const fromBalance = getBalance(db, FROM_ADDR);
    expect(fromBalance?.balance_status).toBe("partial");
    expect(fromBalance?.pending_transfers_count).toBe(1);

    enqueueDecryptJob(db, id!, "0xenc456", CONTRACT_ADDR);

    const sdk = makeMockSdk({ "0xenc456": 1000000n });
    const stopWorker = startWorker(db, sdk);
    await new Promise((r) => setTimeout(r, 300));
    stopWorker();

    const row = db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, id!))
      .get()!;
    expect(row.decrypt_status).toBe("decrypted");
    expect(row.cleartext_amount).toBe(1000000);

    const updatedTransfer = getFullTransferById(db, id!);
    markTransferDecrypted(db, updatedTransfer!);

    const fromAfter = getBalance(db, FROM_ADDR);
    expect(fromAfter?.pending_transfers_count).toBe(0);
    expect(fromAfter?.balance_status).toBe("complete");
    expect(fromAfter?.cleartext_balance).toBe(-1000000);

    const toAfter = getBalance(db, TO_ADDR);
    expect(toAfter?.cleartext_balance).toBe(1000000);
  });

  it("negative: no decryption rights → no_rights, balance stays partial", async () => {
    const id = insertTransfer(db, {
      txHash: "0xccc",
      logIndex: 0,
      blockNumber: 300n,
      blockTimestamp: 3000,
      eventType: "transfer",
      from: FROM_ADDR,
      to: TO_ADDR,
      encryptedHandle: "0xenc789",
    });

    const transfer = getFullTransferById(db, id!);
    updateBalanceForTransfer(db, transfer!);

    enqueueDecryptJob(db, id!, "0xenc789", CONTRACT_ADDR);

    const sdk = makeMockSdk(new DelegationNotFoundError());
    const stopWorker = startWorker(db, sdk);
    await new Promise((r) => setTimeout(r, 300));
    stopWorker();

    const row = db
      .select()
      .from(schema.transfers)
      .where(eq(schema.transfers.id, id!))
      .get()!;
    expect(row.decrypt_status).toBe("no_rights");
    expect(row.cleartext_amount).toBeNull();

    const fromBalance = getBalance(db, FROM_ADDR);
    expect(fromBalance?.pending_transfers_count).toBe(1);
    expect(fromBalance?.balance_status).toBe("partial");
    expect(fromBalance?.cleartext_balance).toBe(0);
  });
});
