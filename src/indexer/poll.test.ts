import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import type { Db } from "../db/connection.js";

vi.mock("../db/state.js", () => ({
  getLastIndexedBlock: vi.fn().mockReturnValue(null),
  setLastIndexedBlock: vi.fn(),
  setChainHeadBlock: vi.fn(),
  getLastIndexedHash: vi.fn().mockReturnValue(null),
  setLastIndexedHash: vi.fn(),
  getStartBlock: vi.fn().mockReturnValue(null),
  setStartBlock: vi.fn(),
}));

vi.mock("../db/transfers.js", () => ({
  insertTransfer: vi.fn(),
  deleteTransfersAfter: vi.fn(),
  updateTransferDecryptStatus: vi.fn(),
}));

vi.mock("../db/queue.js", () => ({
  enqueueDecryptJob: vi.fn(),
}));

vi.mock("../db/balances.js", () => ({
  updateBalanceForTransfer: vi.fn(),
}));

import { resolveStartBlock, storeLogs } from "./poll.js";
import * as state from "../db/state.js";
import * as transfers from "../db/transfers.js";
import * as queueModule from "../db/queue.js";
import type { ParsedTransferEvent } from "./types.js";

function mockDb(): Db {
  return {} as Db;
}

function mockPublicClient(overrides?: {
  getBlock?: (args: {
    blockNumber: bigint;
  }) =>
    | { number: bigint; timestamp: bigint }
    | Promise<{ number: bigint; timestamp: bigint }>;
}): PublicClient {
  return {
    getBlock: vi.fn(
      overrides?.getBlock ??
        (({ blockNumber }: { blockNumber: bigint }) => ({
          number: blockNumber,
          timestamp: blockNumber * 10n + 1000n,
        })),
    ),
  } as unknown as PublicClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveStartBlock", () => {
  it("uses last indexed block from DB when available", () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(42);
    const db = mockDb();

    const result = resolveStartBlock(db, 5000);

    expect(result).toBe(42);
  });

  it("uses explicit startBlock when no DB state", () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(null);
    const db = mockDb();

    const result = resolveStartBlock(db, 5000);

    expect(result).toBe(5000);
  });

  it("prefers DB over param", () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(100);
    const db = mockDb();

    const result = resolveStartBlock(db, 9999);

    expect(result).toBe(100);
  });
});

// ─────────────────────────────────────────────
// storeLogs
// ─────────────────────────────────────────────

describe("storeLogs", () => {
  const CONTRACT_ADDR = "0xdead00000000000000000000000000000000beef" as Address;

  function makeEvent(
    blockNumber: bigint,
    overrides?: Partial<ParsedTransferEvent>,
  ): ParsedTransferEvent {
    return {
      transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      logIndex: 0,
      blockNumber,
      eventType: "transfer",
      from: "0x1111111111111111111111111111111111111111" as Address,
      to: "0x2222222222222222222222222222222222222222" as Address,
      encryptedHandle: "0xabcd" as Hex,
      clearAmount: null,
      ...overrides,
    };
  }

  it("does nothing when events array is empty", async () => {
    const publicClient = mockPublicClient();
    const db = mockDb();

    await storeLogs(db, publicClient, [], CONTRACT_ADDR);

    expect(publicClient.getBlock).not.toHaveBeenCalled();
    expect(transfers.insertTransfer).not.toHaveBeenCalled();
  });

  it("fetches timestamps for unique blocks and inserts transfers", async () => {
    const events = [makeEvent(100n), makeEvent(100n), makeEvent(101n)];
    const publicClient = mockPublicClient();
    const db = mockDb();

    await storeLogs(db, publicClient, events, CONTRACT_ADDR);

    expect(publicClient.getBlock).toHaveBeenCalledTimes(2);
    expect(transfers.insertTransfer).toHaveBeenCalledTimes(3);
  });

  it("chunks getBlock calls in batches of 10", async () => {
    const blockNumbers = Array.from({ length: 25 }, (_, i) => BigInt(100 + i));
    const events = blockNumbers.map((bn) => makeEvent(bn));
    const publicClient = mockPublicClient();
    const db = mockDb();

    await storeLogs(db, publicClient, events, CONTRACT_ADDR);

    expect(publicClient.getBlock).toHaveBeenCalledTimes(25);
    expect(transfers.insertTransfer).toHaveBeenCalledTimes(25);
  }, 15_000);

  it("stores shield events with cleartext amount and zero address from", async () => {
    const publicClient = mockPublicClient();
    const db = mockDb();

    const events: ParsedTransferEvent[] = [
      makeEvent(100n, {
        eventType: "shield",
        from: "0x0000000000000000000000000000000000000000" as Address,
        to: "0x1111111111111111111111111111111111111111" as Address,
        clearAmount: 5000000n,
        encryptedHandle: "0xshieldenc",
      }),
    ];

    await storeLogs(db, publicClient, events, CONTRACT_ADDR);

    expect(transfers.insertTransfer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "shield",
        from: "0x0000000000000000000000000000000000000000",
        to: "0x1111111111111111111111111111111111111111",
        encryptedHandle: "0xshieldenc",
      }),
    );
  });

  it("stores unshield events with cleartext amount and zero address to", async () => {
    const publicClient = mockPublicClient();
    const db = mockDb();

    const events: ParsedTransferEvent[] = [
      makeEvent(100n, {
        eventType: "unshield",
        from: "0x1111111111111111111111111111111111111111" as Address,
        to: "0x0000000000000000000000000000000000000000" as Address,
        clearAmount: 3000000n,
        encryptedHandle: "0xunshieldenc",
      }),
    ];

    await storeLogs(db, publicClient, events, CONTRACT_ADDR);

    expect(transfers.insertTransfer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "unshield",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x0000000000000000000000000000000000000000",
        encryptedHandle: "0xunshieldenc",
      }),
    );
  });

  it("does not enqueue decrypt jobs when encrypted handle is null", async () => {
    const publicClient = mockPublicClient();
    const db = mockDb();
    vi.mocked(transfers.insertTransfer).mockReturnValue(1);

    const events: ParsedTransferEvent[] = [
      makeEvent(100n, { eventType: "transfer", encryptedHandle: null }),
    ];

    await storeLogs(db, publicClient, events, CONTRACT_ADDR);

    expect(queueModule.enqueueDecryptJob).not.toHaveBeenCalled();
  });

  it("enqueues decrypt jobs for transfer events with encrypted handles", async () => {
    const publicClient = mockPublicClient();
    const db = mockDb();
    vi.mocked(transfers.insertTransfer).mockReturnValue(42);

    const events: ParsedTransferEvent[] = [
      makeEvent(100n, {
        eventType: "transfer",
        encryptedHandle: "0xenc",
        clearAmount: null,
      }),
    ];

    await storeLogs(db, publicClient, events, CONTRACT_ADDR);

    expect(queueModule.enqueueDecryptJob).toHaveBeenCalledWith(
      expect.anything(),
      42,
      "0xenc",
      CONTRACT_ADDR,
    );
  });
});
