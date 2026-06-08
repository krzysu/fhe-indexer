import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import type { Db } from "./connection.js";
import {
  getBalance,
  updateBalanceForTransfer,
  markTransferDecrypted,
} from "./balances.js";
import type { TransferRow } from "./transfers.js";

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

function makeTransfer(overrides?: Partial<TransferRow>): TransferRow {
  return {
    id: 1,
    tx_hash: "0xabc",
    log_index: 0,
    block_number: 100,
    block_timestamp: 1000,
    event_type: "transfer",
    from_address: "0xalice",
    to_address: "0xbob",
    encrypted_handle: null,
    cleartext_amount: null,
    decrypt_status: "pending",
    created_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

describe("getBalance", () => {
  it("returns undefined for an unknown address", () => {
    expect(getBalance(db, "0xunknown")).toBeUndefined();
  });

  it("returns the balance row for an existing address", () => {
    updateBalanceForTransfer(
      db,
      makeTransfer({
        event_type: "shield",
        to_address: "0xbob",
        cleartext_amount: 1000,
        decrypt_status: "plain",
        block_number: 50,
      }),
    );

    const row = getBalance(db, "0xbob");
    expect(row).toBeDefined();
    expect(row!.cleartext_balance).toBe(1000);
  });
});

describe("updateBalanceForTransfer", () => {
  describe("shield", () => {
    it("creates a balance row with +amount for to_address", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "shield",
          from_address: "0x0000000000000000000000000000000000000000",
          to_address: "0xbob",
          cleartext_amount: 5000,
          decrypt_status: "plain",
          block_number: 50,
        }),
      );

      const row = getBalance(db, "0xbob");
      expect(row!.cleartext_balance).toBe(5000);
      expect(row!.balance_status).toBe("complete");
      expect(row!.pending_transfers_count).toBe(0);
      expect(row!.last_updated_block).toBe(50);
    });

    it("does not affect from_address (zeroAddress)", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "shield",
          from_address: "0x0000000000000000000000000000000000000000",
          to_address: "0xbob",
          cleartext_amount: 5000,
          decrypt_status: "plain",
        }),
      );

      expect(
        getBalance(db, "0x0000000000000000000000000000000000000000"),
      ).toBeUndefined();
    });

    it("accumulates with existing balance", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "shield",
          to_address: "0xbob",
          cleartext_amount: 1000,
          decrypt_status: "plain",
          block_number: 10,
        }),
      );
      updateBalanceForTransfer(
        db,
        makeTransfer({
          id: 2,
          tx_hash: "0xdef",
          event_type: "shield",
          to_address: "0xbob",
          cleartext_amount: 2000,
          decrypt_status: "plain",
          block_number: 20,
        }),
      );

      expect(getBalance(db, "0xbob")!.cleartext_balance).toBe(3000);
    });
  });

  describe("unshield", () => {
    it("creates a balance row with -amount for from_address", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "unshield",
          from_address: "0xalice",
          to_address: "0x0000000000000000000000000000000000000000",
          cleartext_amount: 3000,
          decrypt_status: "plain",
          block_number: 60,
        }),
      );

      const row = getBalance(db, "0xalice");
      expect(row!.cleartext_balance).toBe(-3000);
      expect(row!.balance_status).toBe("complete");
      expect(row!.pending_transfers_count).toBe(0);
    });

    it("does not affect to_address (zeroAddress)", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "unshield",
          from_address: "0xalice",
          to_address: "0x0000000000000000000000000000000000000000",
          cleartext_amount: 3000,
          decrypt_status: "plain",
        }),
      );

      expect(
        getBalance(db, "0x0000000000000000000000000000000000000000"),
      ).toBeUndefined();
    });
  });

  describe("transfer (plain / cleartext known)", () => {
    it("creates balance rows for both parties with correct signs", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "transfer",
          from_address: "0xalice",
          to_address: "0xbob",
          cleartext_amount: 1000,
          decrypt_status: "decrypted",
          block_number: 70,
        }),
      );

      const alice = getBalance(db, "0xalice")!;
      expect(alice.cleartext_balance).toBe(-1000);
      expect(alice.balance_status).toBe("complete");
      expect(alice.pending_transfers_count).toBe(0);

      const bob = getBalance(db, "0xbob")!;
      expect(bob.cleartext_balance).toBe(1000);
      expect(bob.balance_status).toBe("complete");
      expect(bob.pending_transfers_count).toBe(0);
    });
  });

  describe("transfer (encrypted, pending)", () => {
    it("creates balance rows with delta=0 and pending count +1", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "transfer",
          from_address: "0xalice",
          to_address: "0xbob",
          cleartext_amount: null,
          decrypt_status: "pending",
          block_number: 80,
        }),
      );

      const alice = getBalance(db, "0xalice")!;
      expect(alice.cleartext_balance).toBe(0);
      expect(alice.balance_status).toBe("partial");
      expect(alice.pending_transfers_count).toBe(1);

      const bob = getBalance(db, "0xbob")!;
      expect(bob.cleartext_balance).toBe(0);
      expect(bob.balance_status).toBe("partial");
      expect(bob.pending_transfers_count).toBe(1);
    });

    it("increments pending count on top of existing balance", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "shield",
          to_address: "0xbob",
          cleartext_amount: 5000,
          decrypt_status: "plain",
          block_number: 10,
        }),
      );
      updateBalanceForTransfer(
        db,
        makeTransfer({
          id: 2,
          tx_hash: "0xdef",
          event_type: "transfer",
          from_address: "0xalice",
          to_address: "0xbob",
          cleartext_amount: null,
          decrypt_status: "pending",
          block_number: 80,
        }),
      );

      const bob = getBalance(db, "0xbob")!;
      expect(bob.cleartext_balance).toBe(5000);
      expect(bob.pending_transfers_count).toBe(1);
      expect(bob.balance_status).toBe("partial");
    });
  });

  describe("existing row updates", () => {
    it("updates last_updated_block to the max", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "shield",
          to_address: "0xbob",
          cleartext_amount: 100,
          decrypt_status: "plain",
          block_number: 10,
        }),
      );
      updateBalanceForTransfer(
        db,
        makeTransfer({
          id: 2,
          tx_hash: "0xdef",
          event_type: "shield",
          to_address: "0xbob",
          cleartext_amount: 200,
          decrypt_status: "plain",
          block_number: 5,
        }),
      );

      expect(getBalance(db, "0xbob")!.last_updated_block).toBe(10);
    });

    it("sets status to partial when pending transfers exist", () => {
      updateBalanceForTransfer(
        db,
        makeTransfer({
          event_type: "shield",
          to_address: "0xbob",
          cleartext_amount: 1000,
          decrypt_status: "plain",
        }),
      );
      updateBalanceForTransfer(
        db,
        makeTransfer({
          id: 2,
          tx_hash: "0xdef",
          event_type: "transfer",
          from_address: "0xbob",
          to_address: "0xcharlie",
          cleartext_amount: null,
          decrypt_status: "pending",
        }),
      );

      expect(getBalance(db, "0xbob")!.balance_status).toBe("partial");
    });
  });
});

describe("markTransferDecrypted", () => {
  it("applies cleartext amount and decrements pending count for both parties", () => {
    updateBalanceForTransfer(
      db,
      makeTransfer({
        event_type: "transfer",
        from_address: "0xalice",
        to_address: "0xbob",
        cleartext_amount: null,
        decrypt_status: "pending",
      }),
    );

    markTransferDecrypted(
      db,
      makeTransfer({
        from_address: "0xalice",
        to_address: "0xbob",
        cleartext_amount: 1000,
        decrypt_status: "decrypted",
      }),
    );

    const alice = getBalance(db, "0xalice")!;
    expect(alice.cleartext_balance).toBe(-1000);
    expect(alice.pending_transfers_count).toBe(0);
    expect(alice.balance_status).toBe("complete");

    const bob = getBalance(db, "0xbob")!;
    expect(bob.cleartext_balance).toBe(1000);
    expect(bob.pending_transfers_count).toBe(0);
    expect(bob.balance_status).toBe("complete");
  });

  it("keeps status partial when other pending transfers remain", () => {
    updateBalanceForTransfer(
      db,
      makeTransfer({
        event_type: "transfer",
        from_address: "0xalice",
        to_address: "0xbob",
        cleartext_amount: null,
        decrypt_status: "pending",
      }),
    );
    updateBalanceForTransfer(
      db,
      makeTransfer({
        id: 2,
        tx_hash: "0xdef",
        event_type: "transfer",
        from_address: "0xalice",
        to_address: "0xbob",
        cleartext_amount: null,
        decrypt_status: "pending",
        block_number: 200,
      }),
    );

    markTransferDecrypted(
      db,
      makeTransfer({
        from_address: "0xalice",
        to_address: "0xbob",
        cleartext_amount: 500,
        decrypt_status: "decrypted",
      }),
    );

    const alice = getBalance(db, "0xalice")!;
    expect(alice.pending_transfers_count).toBe(1);
    expect(alice.balance_status).toBe("partial");
    expect(alice.cleartext_balance).toBe(-500);
  });

  it("does nothing if the address has no balance row", () => {
    markTransferDecrypted(
      db,
      makeTransfer({
        from_address: "0xalice",
        to_address: "0xbob",
        cleartext_amount: 1000,
        decrypt_status: "decrypted",
      }),
    );

    expect(getBalance(db, "0xalice")).toBeUndefined();
    expect(getBalance(db, "0xbob")).toBeUndefined();
  });

  it("does nothing if pending_transfers_count is 0", () => {
    updateBalanceForTransfer(
      db,
      makeTransfer({
        event_type: "shield",
        to_address: "0xbob",
        cleartext_amount: 1000,
        decrypt_status: "plain",
      }),
    );

    markTransferDecrypted(
      db,
      makeTransfer({
        from_address: "0xalice",
        to_address: "0xbob",
        cleartext_amount: 500,
        decrypt_status: "decrypted",
      }),
    );

    expect(getBalance(db, "0xbob")!.cleartext_balance).toBe(1000);
  });

  it("handles both parties being the same address", () => {
    updateBalanceForTransfer(
      db,
      makeTransfer({
        event_type: "transfer",
        from_address: "0xalice",
        to_address: "0xalice",
        cleartext_amount: null,
        decrypt_status: "pending",
      }),
    );

    markTransferDecrypted(
      db,
      makeTransfer({
        from_address: "0xalice",
        to_address: "0xalice",
        cleartext_amount: 1000,
        decrypt_status: "decrypted",
      }),
    );

    const alice = getBalance(db, "0xalice")!;
    expect(alice.cleartext_balance).toBe(0);
    expect(alice.pending_transfers_count).toBe(0);
  });
});
