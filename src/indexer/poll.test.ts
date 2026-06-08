import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address, PublicClient } from "viem";
import type { Db } from "../db/connection.js";

vi.mock("../db/state.js", () => ({
  getLastIndexedBlock: vi.fn(),
  setLastIndexedBlock: vi.fn(),
  setChainHeadBlock: vi.fn(),
}));

vi.mock("../db/transfers.js", () => ({
  insertTransfer: vi.fn(),
}));

import {
  resolveContractCreationBlock,
  resolveStartBlock,
  storeLogs,
} from "./poll.js";
import * as state from "../db/state.js";
import * as transfers from "../db/transfers.js";
import {
  confidentialTransferEvent,
  type ConfidentialTransferLog,
} from "./events.js";

const CONTRACT = "0xdead00000000000000000000000000000000beef" as Address;
const EMPTY_CODE = "0x";
const NONEMPTY_CODE = "0x1234";

function mockPublicClient(overrides?: {
  getBlockNumber?: () => bigint | Promise<bigint>;
  getCode?: (args: {
    address: Address;
    blockNumber: bigint;
  }) => string | Promise<string>;
  getLogs?: (args: {
    address: Address;
    event: typeof confidentialTransferEvent;
    fromBlock: bigint;
    toBlock: bigint;
  }) => ConfidentialTransferLog[] | Promise<ConfidentialTransferLog[]>;
  getBlock?: (args: {
    blockNumber: bigint;
  }) =>
    | { number: bigint; timestamp: bigint }
    | Promise<{ number: bigint; timestamp: bigint }>;
}): PublicClient {
  return {
    getBlockNumber: vi.fn(overrides?.getBlockNumber ?? (() => 10_000_000n)),
    getCode: vi.fn(overrides?.getCode ?? ((() => EMPTY_CODE) as () => string)),
    getLogs: vi.fn(
      overrides?.getLogs ?? (() => [] as ConfidentialTransferLog[]),
    ),
    getBlock: vi.fn(
      overrides?.getBlock ??
        (({ blockNumber }: { blockNumber: bigint }) => ({
          number: blockNumber,
          timestamp: blockNumber * 10n + 1000n,
        })),
    ),
  } as unknown as PublicClient;
}

function mockDb(): Db {
  return {} as Db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────
// resolveContractCreationBlock
// ─────────────────────────────────────────────

describe("resolveContractCreationBlock", () => {
  it("returns the first block with an event", async () => {
    const FIRST_EVENT = 5_000_000n;
    const publicClient = mockPublicClient({
      getBlockNumber: () => 10_000_000n,
      getCode: () => NONEMPTY_CODE,
      getLogs: ({ fromBlock, toBlock }) => {
        const inRange = fromBlock <= FIRST_EVENT && toBlock >= FIRST_EVENT;
        return inRange
          ? [{ blockNumber: FIRST_EVENT } as ConfidentialTransferLog]
          : [];
      },
    });

    const result = await resolveContractCreationBlock(publicClient, CONTRACT);

    expect(result).toBe(Number(FIRST_EVENT));
  });

  it("returns current block when contract has no events", async () => {
    const publicClient = mockPublicClient({
      getBlockNumber: () => 10_000_000n,
      getCode: () => NONEMPTY_CODE,
      getLogs: () => [],
    });

    const result = await resolveContractCreationBlock(publicClient, CONTRACT);

    expect(result).toBe(10_000_000);
  });

  it("throws when contract does not exist at current block", async () => {
    const publicClient = mockPublicClient({
      getBlockNumber: () => 10_000_000n,
      getCode: () => EMPTY_CODE,
    });

    await expect(
      resolveContractCreationBlock(publicClient, CONTRACT),
    ).rejects.toThrow(/No code found/);
  });

  it("throws when getCode fails at current block", async () => {
    const publicClient = mockPublicClient({
      getBlockNumber: () => 10_000_000n,
      getCode: () => {
        throw new Error("RPC error");
      },
    });

    await expect(
      resolveContractCreationBlock(publicClient, CONTRACT),
    ).rejects.toThrow();
  });

  it("makes O(log n) getLogs calls", async () => {
    const FIRST_EVENT = 7_345_000n;
    const publicClient = mockPublicClient({
      getBlockNumber: () => 10_000_000n,
      getCode: () => NONEMPTY_CODE,
      getLogs: ({ fromBlock, toBlock }) => {
        const inRange = fromBlock <= FIRST_EVENT && toBlock >= FIRST_EVENT;
        return inRange
          ? [{ blockNumber: FIRST_EVENT } as ConfidentialTransferLog]
          : [];
      },
    });

    await resolveContractCreationBlock(publicClient, CONTRACT);

    const calls = (publicClient.getLogs as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(calls).toBeLessThanOrEqual(25);
  });
});

// ─────────────────────────────────────────────
// resolveStartBlock
// ─────────────────────────────────────────────

describe("resolveStartBlock", () => {
  beforeEach(() => {
    delete process.env.START_BLOCK;
  });

  it("uses last indexed block from DB when available", async () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(42);
    const publicClient = mockPublicClient();
    const db = mockDb();

    const result = await resolveStartBlock(db, publicClient, CONTRACT);

    expect(result).toBe(42);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(publicClient.getCode).not.toHaveBeenCalled();
  });

  it("uses explicit startBlock param when no DB state", async () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(null);
    const publicClient = mockPublicClient();
    const db = mockDb();

    const result = await resolveStartBlock(db, publicClient, CONTRACT, 5000);

    expect(result).toBe(5000);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(publicClient.getCode).not.toHaveBeenCalled();
  });

  it("uses START_BLOCK env var when no DB state and no param", async () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(null);
    process.env.START_BLOCK = "9999";
    const publicClient = mockPublicClient();
    const db = mockDb();

    const result = await resolveStartBlock(db, publicClient, CONTRACT);

    expect(result).toBe(9999);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(publicClient.getCode).not.toHaveBeenCalled();
  });

  it("falls back to chain when no DB, no param, no env", async () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(null);
    const FIRST_EVENT = 5_000_000n;
    const publicClient = mockPublicClient({
      getBlockNumber: () => 10_000_000n,
      getCode: () => NONEMPTY_CODE,
      getLogs: ({ fromBlock, toBlock }) => {
        const inRange = fromBlock <= FIRST_EVENT && toBlock >= FIRST_EVENT;
        return inRange
          ? [{ blockNumber: FIRST_EVENT } as ConfidentialTransferLog]
          : [];
      },
    });
    const db = mockDb();

    const result = await resolveStartBlock(db, publicClient, CONTRACT);

    expect(result).toBe(Number(FIRST_EVENT));
  });

  it("prefers DB over env var", async () => {
    vi.mocked(state.getLastIndexedBlock).mockReturnValue(100);
    process.env.START_BLOCK = "9999";
    const publicClient = mockPublicClient();
    const db = mockDb();

    const result = await resolveStartBlock(db, publicClient, CONTRACT);

    expect(result).toBe(100);
  });
});

// ─────────────────────────────────────────────
// storeLogs
// ─────────────────────────────────────────────

describe("storeLogs", () => {
  function makeLog(
    blockNumber: bigint,
    overrides?: Partial<ConfidentialTransferLog>,
  ): ConfidentialTransferLog {
    return {
      blockNumber,
      transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      logIndex: 0,
      args: {
        from: "0x1111111111111111111111111111111111111111" as Address,
        to: "0x2222222222222222222222222222222222222222" as Address,
        encryptedAmount: "0xabcd" as `0x${string}`,
      },
      ...overrides,
    } as unknown as ConfidentialTransferLog;
  }

  it("does nothing when logs array is empty", async () => {
    const publicClient = mockPublicClient();
    const db = mockDb();

    await storeLogs(db, publicClient, []);

    expect(publicClient.getBlock).not.toHaveBeenCalled();
    expect(transfers.insertTransfer).not.toHaveBeenCalled();
  });

  it("fetches timestamps for unique blocks and inserts transfers", async () => {
    const logs = [makeLog(100n), makeLog(100n), makeLog(101n)];
    const publicClient = mockPublicClient();
    const db = mockDb();

    await storeLogs(db, publicClient, logs);

    expect(publicClient.getBlock).toHaveBeenCalledTimes(2);
    expect(transfers.insertTransfer).toHaveBeenCalledTimes(3);
  });

  it("chunks getBlock calls in batches of 10", async () => {
    const blockNumbers = Array.from({ length: 25 }, (_, i) => BigInt(100 + i));
    const logs = blockNumbers.map((bn) => makeLog(bn));
    const publicClient = mockPublicClient();
    const db = mockDb();

    await storeLogs(db, publicClient, logs);

    expect(publicClient.getBlock).toHaveBeenCalledTimes(25);
    expect(transfers.insertTransfer).toHaveBeenCalledTimes(25);
  });
});
