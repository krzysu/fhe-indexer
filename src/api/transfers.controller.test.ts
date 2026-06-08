import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "../db/connection.js";
import type { TransferRow } from "../db/transfers.js";

vi.mock("../db/transfers.js", () => ({
  getAllTransfers: vi.fn(),
  getTransfersByAddress: vi.fn(),
}));

import { TransfersController } from "./transfers.controller.js";
import * as transfersDb from "../db/transfers.js";

function mockDb(): Db {
  return {} as Db;
}

function makeRow(overrides?: Partial<TransferRow>): TransferRow {
  return {
    id: 1,
    tx_hash: "0xabc",
    log_index: 0,
    block_number: 100,
    block_timestamp: 1000,
    event_type: "transfer",
    from_address: "0xfrom",
    to_address: "0xto",
    encrypted_handle: "0xenc",
    cleartext_amount: null,
    decrypt_status: "pending",
    created_at: "2026-01-01",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────
// getAll
// ─────────────────────────────────────────────

describe("GET /transfers", () => {
  it("returns transfers with default pagination", () => {
    vi.mocked(transfersDb.getAllTransfers).mockReturnValue({
      rows: [makeRow()],
      total: 1,
    });

    const controller = new TransfersController(mockDb());
    const result = controller.getAll();

    expect(transfersDb.getAllTransfers).toHaveBeenCalledWith(
      expect.anything(),
      1,
      20,
    );
    expect(result.data).toHaveLength(1);
    expect(result.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
  });

  it("clamps page to minimum of 1", () => {
    vi.mocked(transfersDb.getAllTransfers).mockReturnValue({
      rows: [],
      total: 0,
    });

    const controller = new TransfersController(mockDb());
    controller.getAll("0");
    controller.getAll("-5");
    controller.getAll("abc");

    for (const call of vi.mocked(transfersDb.getAllTransfers).mock.calls) {
      expect(call[1]).toBe(1);
    }
  });

  it("clamps limit between 1 and 100", () => {
    vi.mocked(transfersDb.getAllTransfers).mockReturnValue({
      rows: [],
      total: 0,
    });

    const controller = new TransfersController(mockDb());
    controller.getAll("1", "0"); // 0 is falsy → falls back to DEFAULT_LIMIT (20)
    controller.getAll("1", "-5"); // negative → clamped to 1
    controller.getAll("1", "200"); // over 100 → clamped to 100
    controller.getAll("1", "abc"); // NaN → falls back to DEFAULT_LIMIT (20)

    const calls = vi.mocked(transfersDb.getAllTransfers).mock.calls;
    expect(calls[0]![2]).toBe(20);
    expect(calls[1]![2]).toBe(1);
    expect(calls[2]![2]).toBe(100);
    expect(calls[3]![2]).toBe(20);
  });

  it("formats response shape correctly", () => {
    vi.mocked(transfersDb.getAllTransfers).mockReturnValue({
      rows: [
        makeRow({
          tx_hash: "0xtx",
          block_number: 42,
          block_timestamp: 999,
          event_type: "shield",
          from_address: "0xa",
          to_address: "0xb",
          cleartext_amount: 5000,
          decrypt_status: "decrypted",
        }),
      ],
      total: 1,
    });

    const controller = new TransfersController(mockDb());
    const result = controller.getAll("1", "10");

    expect(result.data[0]).toEqual({
      txHash: "0xtx",
      blockNumber: 42,
      timestamp: 999,
      eventType: "shield",
      from: "0xa",
      to: "0xb",
      amount: "5000",
      decryptStatus: "decrypted",
    });
  });

  it("returns null amount when cleartext_amount is null", () => {
    vi.mocked(transfersDb.getAllTransfers).mockReturnValue({
      rows: [makeRow({ cleartext_amount: null })],
      total: 1,
    });

    const controller = new TransfersController(mockDb());
    const result = controller.getAll();

    expect(result.data[0]!.amount).toBeNull();
  });
});

// ─────────────────────────────────────────────
// getByAddress
// ─────────────────────────────────────────────

describe("GET /transfers/:address", () => {
  it("returns transfers for the given address", () => {
    vi.mocked(transfersDb.getTransfersByAddress).mockReturnValue({
      rows: [makeRow({ from_address: "0xalice" })],
      total: 1,
    });

    const controller = new TransfersController(mockDb());
    const result = controller.getByAddress("0xalice");

    expect(transfersDb.getTransfersByAddress).toHaveBeenCalledWith(
      expect.anything(),
      "0xalice",
      1,
      20,
    );
    expect(result.data).toHaveLength(1);
  });

  it("clamps pagination same as getAll", () => {
    vi.mocked(transfersDb.getTransfersByAddress).mockReturnValue({
      rows: [],
      total: 0,
    });

    const controller = new TransfersController(mockDb());
    controller.getByAddress("0xaddr", "-1", "200");

    expect(transfersDb.getTransfersByAddress).toHaveBeenCalledWith(
      expect.anything(),
      "0xaddr",
      1,
      100,
    );
  });

  it("computed totalPages correctly", () => {
    vi.mocked(transfersDb.getTransfersByAddress).mockReturnValue({
      rows: Array.from({ length: 10 }, () => makeRow()),
      total: 25,
    });

    const controller = new TransfersController(mockDb());
    const result = controller.getByAddress("0xaddr", "1", "10");

    expect(result.pagination.totalPages).toBe(3);
  });
});
