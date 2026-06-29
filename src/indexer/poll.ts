import { type Address, type PublicClient, getAddress, zeroAddress } from "viem";
import type { Db } from "../db/connection.js";
import { insertTransfer } from "../db/transfers.js";
import { deleteTransfersAfter } from "../db/transfers.js";
import { enqueueDecryptJob } from "../db/queue.js";
import { updateBalanceForTransfer } from "../db/balances.js";
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

/**
 * Poller loop interval. Short enough to keep the API "fresh", long
 * enough to stay well under free-RPC request budgets.
 */
const POLL_INTERVAL = 30_000;

/**
 * Number of blocks we wait past the chain tip before processing them.
 * Covers shallow Sepolia reorgs; deeper reorgs would be missed.
 */
const CONFIRMATION_DEPTH = 5;

/**
 * Upper bound on a single `eth_getLogs` window. Public RPCs cap this
 * (often 10k); paid plans support more. The poller chunks larger ranges.
 */
const MAX_BLOCK_RANGE = 50_000;

/** Sleep between chunks during catch-up to avoid bursting the RPC. */
const CHUNK_DELAY_MS = 2_000;

/** Base delay for the rate-limit exponential-backoff retry loop. */
const RATE_LIMIT_BASE_MS = 5_000;

/** Cap on rate-limit retries before propagating the error. */
const MAX_RATE_LIMIT_RETRIES = 8;

/**
 * Number of blocks batched into one `getBlock` multicall when fetching
 * timestamps. Keeps RPC roundtrips low during catch-up.
 */
const BLOCK_BATCH_SIZE = 10;

/** Delay between timestamp-batches to avoid rate-limit spikes. */
const BLOCK_BATCH_DELAY_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Detects HTTP 429 (Too Many Requests) and viem RPC code -32005
 * (the JSON-RPC "limit exceeded" code some providers use).
 */
function isRateLimitError(err: unknown): boolean {
  return (
    (err as { status?: number })?.status === 429 ||
    (err as { cause?: { code?: number } })?.cause?.code === -32005
  );
}

/**
 * Exponential backoff with full jitter: `base * 2^attempt + random(base)`.
 * The randomness prevents thundering-herd retries across parallel workers.
 */
function backoffDelay(attempt: number): number {
  const exp = RATE_LIMIT_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RATE_LIMIT_BASE_MS;
  return exp + jitter;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= MAX_RATE_LIMIT_RETRIES)
        throw err;

      const delay = backoffDelay(attempt);
      console.warn(
        `[poller] rate limited: ${label} (retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}), waiting ${(delay / 1000).toFixed(1)}s...`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Determines where indexing should resume. Priority:
 *   1. `last_indexed_block` from DB (resumability after restart),
 *   2. persisted `start_block` from a prior run,
 *   3. `START_BLOCK` env var (only on a fresh DB).
 * Persists the resolved start_block once so subsequent restarts are stable.
 */
export function resolveStartBlock(db: Db, startBlock: number): number {
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

/** `getBlock` wrapped in the rate-limit retry loop (used for timestamps + reorg check). */
async function fetchBlock(publicClient: PublicClient, blockNumber: bigint) {
  return withRetry(
    () => publicClient.getBlock({ blockNumber }),
    `getBlock(${blockNumber})`,
  );
}

/**
 * Generic `getLogs` wrapper for a single event ABI over a block range.
 * Used three times in parallel per chunk — one per event type — to
 * minimize catch-up latency.
 */
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

/**
 * Maps a raw `ConfidentialTransfer` log to our internal shape. The
 * amount is encrypted (`bytes32` handle), so `clearAmount = null` —
 * the worker will later resolve it via the Zama SDK.
 * Filters out zero-address participants (defensive — shouldn't happen).
 */
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

/**
 * Shield (wrap) = depositing underlying ERC-20 into the confidential layer.
 * Logically a mint: `from = 0x0`, `to = args.from`. Amount is cleartext.
 */
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

/**
 * Unshield (unwrap) = withdrawing from confidential back to ERC-20.
 * Logically a burn: `from = args.receiver`, `to = 0x0`. Amount is cleartext.
 */
function parseUnwrapFinalized(log: UnwrapFinalizedLog): ParsedTransferEvent {
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

/**
 * Persists a batch of parsed events. For each event:
 *   - batch-fetches block timestamps (RPC-light, 10 at a time),
 *   - inserts into `transfers` (idempotent via `(tx_hash, log_index)` unique),
 *   - applies a balance delta via `updateBalanceForTransfer`,
 *   - enqueues a `decrypt_queue` job if the event has an encrypted handle.
 * The decrypt job enqueue is independent of balance updates — shield/unshield
 * have cleartext amounts and don't need decryption.
 */
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
    const blockTimestamp = blockTimestamps.get(Number(event.blockNumber)) ?? 0;
    const cleartextAmount =
      event.clearAmount !== null ? event.clearAmount : undefined;
    const decryptStatus = event.clearAmount !== null ? "plain" : "pending";

    const id = insertTransfer(db, {
      txHash: event.transactionHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      blockTimestamp,
      eventType: event.eventType,
      from: event.from,
      to: event.to,
      encryptedHandle: event.encryptedHandle,
      cleartextAmount,
      decryptStatus,
    });

    if (id !== undefined) {
      updateBalanceForTransfer(db, {
        id,
        tx_hash: event.transactionHash,
        log_index: event.logIndex,
        block_number: Number(event.blockNumber),
        block_timestamp: blockTimestamp,
        event_type: event.eventType,
        from_address: event.from,
        to_address: event.to,
        encrypted_handle: event.encryptedHandle,
        cleartext_amount:
          cleartextAmount !== undefined ? Number(cleartextAmount) : null,
        decrypt_status: decryptStatus,
        created_at: new Date().toISOString(),
      });

      if (event.encryptedHandle) {
        enqueueDecryptJob(db, id, event.encryptedHandle, contractAddress);
      }
    }
  }
}

/**
 * Walks the [from, safeHead] range in chunks of `MAX_BLOCK_RANGE`. Per chunk:
 *   - fetch all three event types in parallel,
 *   - parse + merge + sort by (blockNumber, logIndex),
 *   - persist via `storeLogs`,
 *   - advance the checkpoint (`last_indexed_block`) atomically,
 *   - sleep `CHUNK_DELAY_MS` before the next chunk.
 * Sort order matters for balance correctness: a transfer must be applied
 * after any shield at the same block+lower-logIndex.
 */
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
        publicClient,
        contractAddress,
        confidentialTransferEvent,
        from,
        batchEnd,
      ),
      fetchLogsForEvent<WrapLog>(
        publicClient,
        contractAddress,
        wrapEvent,
        from,
        batchEnd,
      ),
      fetchLogsForEvent<UnwrapFinalizedLog>(
        publicClient,
        contractAddress,
        unwrapFinalizedEvent,
        from,
        batchEnd,
      ),
    ]);

    const parsedEvents: ParsedTransferEvent[] = [
      ...transferLogs
        .map(parseConfidentialTransfer)
        .filter((e): e is ParsedTransferEvent => e !== null),
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

/**
 * Returns the highest block safe to index = chain head − CONFIRMATION_DEPTH.
 * Anything beyond this could be reorged out, so we wait.
 */
async function getSafeHead(publicClient: PublicClient): Promise<bigint> {
  const chainHead = await withRetry(
    () => publicClient.getBlockNumber(),
    "getBlockNumber",
  );
  console.log(`[poller] chain head block: ${chainHead}`);
  return chainHead - BigInt(CONFIRMATION_DEPTH);
}

/**
 * One polling cycle:
 *   1. compute safe head and persist it (for `/health` lag reporting),
 *   2. resolve resume point (reorg check + last_indexed_block fallback),
 *   3. if reorg detected: roll back transfers to `safeBlock` (CASCADE
 *      purges the decrypt queue), reset checkpoint, return,
 *   4. if already at head: skip, wait for next tick,
 *   5. otherwise: chunk-index up to safe head, write new hash checkpoint.
 * All errors are caught at the top level so a transient RPC failure
 * doesn't kill the loop — the next tick retries.
 */
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
            const safeBlockData = await fetchBlock(
              publicClient,
              BigInt(safeBlock),
            );
            setLastIndexedHash(db, safeBlockData.hash);
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

/**
 * Bootstraps the poller: schedules the first tick immediately, then every
 * `POLL_INTERVAL`. Guards against overlapping cycles with a `polling` flag
 * (defensive — current cycles should finish well under 30s, but long
 * catch-ups or slow RPCs could overlap).
 * Returns a stop function used by the shutdown handler.
 */
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
