import { type Address, type PublicClient, getAddress, zeroAddress } from "viem";
import type { Db } from "../db/connection.js";
import { insertTransfer } from "../db/transfers.js";
import { deleteTransfersAfter } from "../db/transfers.js";
import { enqueueDecryptJob } from "../db/queue.js";
import {
  getLastIndexedBlock,
  setLastIndexedBlock,
  setLastIndexedHash,
  getLastIndexedHash,
  getStartBlock,
  setStartBlock,
  setChainHeadBlock,
} from "../db/state.js";
import {
  confidentialTransferEvent,
  wrapEvent,
  unwrapFinalizedEvent,
  type ConfidentialTransferLog,
  type WrapLog,
  type UnwrapFinalizedLog,
} from "./events.js";
import type { ParsedTransferEvent } from "./types.js";

const POLL_INTERVAL = 30_000;
const CONFIRMATION_DEPTH = 5;
const MAX_BLOCK_RANGE = 50_000;
const CHUNK_DELAY_MS = 2_000;
const RATE_LIMIT_BASE_MS = 5_000;
const MAX_RATE_LIMIT_RETRIES = 8;
const BLOCK_BATCH_SIZE = 10;
const BLOCK_BATCH_DELAY_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimitError(err: unknown): boolean {
  return (
    (err as { status?: number })?.status === 429 ||
    (err as { cause?: { code?: number } })?.cause?.code === -32005
  );
}

function backoffDelay(attempt: number): number {
  const exp = RATE_LIMIT_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RATE_LIMIT_BASE_MS;
  return exp + jitter;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;

      const delay = backoffDelay(attempt);
      console.warn(
        `[poller] rate limited: ${label} (retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}), waiting ${(delay / 1000).toFixed(1)}s...`,
      );
      await sleep(delay);
    }
  }
}

export function resolveStartBlock(
  db: Db,
  startBlock: number,
): number {
  const last = getLastIndexedBlock(db);
  if (last !== null) {
    console.log(`[poller] last indexed block from db: ${last}`);
    return last;
  }

  const storedStart = getStartBlock(db);
  if (storedStart !== null) {
    console.log(`[poller] using stored start block ${storedStart}`);
    return storedStart;
  }

  console.log(`[poller] using configured start block ${startBlock}`);
  setStartBlock(db, startBlock);
  return startBlock;
}

async function fetchBlock(
  publicClient: PublicClient,
  blockNumber: bigint,
) {
  return withRetry(
    () => publicClient.getBlock({ blockNumber }),
    `getBlock(${blockNumber})`,
  );
}

async function fetchLogsForEvent<T>(
  publicClient: PublicClient,
  contractAddress: Address,
  event: object,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<T[]> {
  return withRetry(
    () =>
      publicClient.getLogs({
        address: contractAddress,
        event: event as never,
        fromBlock,
        toBlock,
      }) as unknown as Promise<T[]>,
    `getLogs(${fromBlock}-${toBlock})`,
  );
}

function parseConfidentialTransfer(
  log: ConfidentialTransferLog,
): ParsedTransferEvent | null {
  const from = getAddress(log.args.from);
  const to = getAddress(log.args.to);

  if (from === zeroAddress || to === zeroAddress) return null;

  return {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    eventType: "transfer",
    from,
    to,
    encryptedHandle: log.args.encryptedAmount,
    clearAmount: null,
  };
}

function parseWrap(log: WrapLog): ParsedTransferEvent {
  return {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    eventType: "shield",
    from: zeroAddress,
    to: getAddress(log.args.from),
    encryptedHandle: log.args.encryptedAmount,
    clearAmount: log.args.clearAmount,
  };
}

function parseUnwrapFinalized(
  log: UnwrapFinalizedLog,
): ParsedTransferEvent {
  return {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    eventType: "unshield",
    from: getAddress(log.args.receiver),
    to: zeroAddress,
    encryptedHandle: log.args.encryptedAmount,
    clearAmount: log.args.cleartextAmount,
  };
}

export async function storeLogs(
  db: Db,
  publicClient: PublicClient,
  events: ParsedTransferEvent[],
  contractAddress: Address,
): Promise<void> {
  if (events.length === 0) return;

  const uniqueBlocks = [...new Set(events.map((e) => Number(e.blockNumber)))];
  console.log(
    `[poller] storing ${events.length} events from ${uniqueBlocks.length} unique blocks`,
  );

  const blockTimestamps = new Map<number, number>();
  for (let i = 0; i < uniqueBlocks.length; i += BLOCK_BATCH_SIZE) {
    const chunk = uniqueBlocks.slice(i, i + BLOCK_BATCH_SIZE);
    const blocks = await Promise.all(
      chunk.map((bn) => fetchBlock(publicClient, BigInt(bn))),
    );
    for (const b of blocks) {
      blockTimestamps.set(Number(b.number!), Number(b.timestamp!));
    }
    if (i + BLOCK_BATCH_SIZE < uniqueBlocks.length) {
      await sleep(BLOCK_BATCH_DELAY_MS);
    }
  }

  for (const event of events) {
    const id = insertTransfer(db, {
      txHash: event.transactionHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      blockTimestamp: blockTimestamps.get(Number(event.blockNumber)) ?? 0,
      eventType: event.eventType,
      from: event.from,
      to: event.to,
      encryptedHandle: event.encryptedHandle,
    });

    if (id !== undefined && event.encryptedHandle) {
      enqueueDecryptJob(db, id, event.encryptedHandle, contractAddress);
    }
  }
}

async function indexRange(
  db: Db,
  publicClient: PublicClient,
  contractAddress: Address,
  from: bigint,
  safeHead: bigint,
): Promise<void> {
  const total = safeHead - from + BigInt(1);
  console.log(
    `[poller] catch-up started: ${total} blocks to index (${Number(total / 1000n)}k)`,
  );

  while (from < safeHead) {
    const to = from + BigInt(MAX_BLOCK_RANGE);
    const batchEnd = to > safeHead ? safeHead : to;

    const [transferLogs, wrapLogs, unwrapLogs] = await Promise.all([
      fetchLogsForEvent<ConfidentialTransferLog>(
        publicClient, contractAddress, confidentialTransferEvent, from, batchEnd,
      ),
      fetchLogsForEvent<WrapLog>(
        publicClient, contractAddress, wrapEvent, from, batchEnd,
      ),
      fetchLogsForEvent<UnwrapFinalizedLog>(
        publicClient, contractAddress, unwrapFinalizedEvent, from, batchEnd,
      ),
    ]);

    const parsedEvents: ParsedTransferEvent[] = [
      ...transferLogs.map(parseConfidentialTransfer).filter((e): e is ParsedTransferEvent => e !== null),
      ...wrapLogs.map(parseWrap),
      ...unwrapLogs.map(parseUnwrapFinalized),
    ];

    parsedEvents.sort(
      (a, b) =>
        Number(a.blockNumber) - Number(b.blockNumber) ||
        a.logIndex - b.logIndex,
    );

    console.log(
      `[poller] fetched blocks ${from}–${batchEnd}: ${transferLogs.length} transfers, ${wrapLogs.length} wraps, ${unwrapLogs.length} unwraps`,
    );

    await storeLogs(db, publicClient, parsedEvents, contractAddress);

    setLastIndexedBlock(db, Number(batchEnd));
    from = batchEnd + BigInt(1);

    await sleep(CHUNK_DELAY_MS);
  }

  console.log(`[poller] catch-up done, up to block ${safeHead}`);
}

async function getSafeHead(publicClient: PublicClient): Promise<bigint> {
  const chainHead = await withRetry(
    () => publicClient.getBlockNumber(),
    "getBlockNumber",
  );
  console.log(`[poller] chain head block: ${chainHead}`);
  return chainHead - BigInt(CONFIRMATION_DEPTH);
}

async function poll(
  db: Db,
  publicClient: PublicClient,
  contractAddress: Address,
  startBlock: number,
): Promise<void> {
  try {
    const safeHead = await getSafeHead(publicClient);
    setChainHeadBlock(db, Number(safeHead + BigInt(CONFIRMATION_DEPTH)));

    const last = resolveStartBlock(db, startBlock);

    const resolvedStart = getStartBlock(db) ?? last;

    if (last > resolvedStart) {
      const checkpointHash = getLastIndexedHash(db);
      if (checkpointHash) {
        try {
          const block = await fetchBlock(publicClient, BigInt(last));
          if (block.hash !== checkpointHash) {
            console.warn(`[poller] reorg detected at block ${last}`);
            const safeBlock = Math.max(
              last - CONFIRMATION_DEPTH,
              resolvedStart,
            );
            deleteTransfersAfter(db, safeBlock);
            setLastIndexedBlock(db, safeBlock);
            setLastIndexedHash(db, block.hash);
            return;
          }
        } catch (err) {
          console.error(`[poller] reorg check failed:`, err);
        }
      }
    }

    if (safeHead <= BigInt(last)) {
      console.log(
        `[poller] up to date (block ${last}), next poll in ${POLL_INTERVAL / 1000}s`,
      );
      return;
    }

    console.log(`[poller] indexing blocks ${last + 1}–${safeHead}`);
    await indexRange(
      db,
      publicClient,
      contractAddress,
      BigInt(last + 1),
      safeHead,
    );

    try {
      const block = await fetchBlock(publicClient, BigInt(safeHead));
      setLastIndexedHash(db, block.hash);
    } catch (err) {
      console.error(`[poller] failed to update hash checkpoint:`, err);
    }
  } catch (err) {
    console.error("[poller] error:", err);
  }
}

export function startPoller(
  db: Db,
  publicClient: PublicClient,
  contractAddress: Address,
  startBlock: number,
): () => void {
  console.log("[poller] started");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;

  async function tick() {
    if (polling) {
      console.log("[poller] previous poll still in progress, skipping cycle");
      timer = setTimeout(tick, POLL_INTERVAL);
      return;
    }
    polling = true;
    await poll(db, publicClient, contractAddress, startBlock);
    polling = false;
    timer = setTimeout(tick, POLL_INTERVAL);
  }

  timer = setTimeout(tick, 0);

  return () => {
    console.log("[poller] stopped");
    if (timer) clearTimeout(timer);
  };
}
