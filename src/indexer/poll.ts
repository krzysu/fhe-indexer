import { type Address, type PublicClient, getAddress } from "viem";
import type { Db } from "../db/connection.js";
import { insertTransfer } from "../db/transfers.js";
import {
  getLastIndexedBlock,
  setLastIndexedBlock,
  setChainHeadBlock,
} from "../db/state.js";
import {
  confidentialTransferEvent,
  type ConfidentialTransferLog,
} from "./events.js";

const POLL_INTERVAL = 30_000;
const CONFIRMATION_DEPTH = 5;

const MAX_BLOCK_RANGE = 50_000;
const CHUNK_DELAY_MS = 2_000;
const RATE_LIMIT_RETRY_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const BLOCK_BATCH_SIZE = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getSafeHead(publicClient: PublicClient): Promise<bigint> {
  const chainHead = await publicClient.getBlockNumber();
  console.log(`[poller] chain head block: ${chainHead}`);
  return chainHead - BigInt(CONFIRMATION_DEPTH);
}

export async function resolveContractCreationBlock(
  publicClient: PublicClient,
  contractAddress: Address,
): Promise<number> {
  let high = await publicClient.getBlockNumber();

  const currentCode = await publicClient.getCode({
    address: contractAddress,
    blockNumber: high,
  });
  if (!currentCode || currentCode === "0x") {
    throw new Error(
      `No code found at contract ${contractAddress} on block ${high}`,
    );
  }

  // Binary search using getLogs to find the first event block.
  // Works on non-archive nodes since historical logs are always available.
  let low = 0n;

  while (low < high) {
    const mid = (low + high) / 2n;
    const logs = await publicClient.getLogs({
      address: contractAddress,
      event: confidentialTransferEvent,
      fromBlock: low,
      toBlock: mid,
    });
    if ((logs as unknown[]).length > 0) {
      high = mid;
    } else {
      low = mid + 1n;
    }
  }

  console.log(`[poller] contract creation block: ${low}`);
  return Number(low);
}

export async function resolveStartBlock(
  db: Db,
  publicClient: PublicClient,
  contractAddress: Address,
  startBlock?: number,
): Promise<number> {
  const last = getLastIndexedBlock(db);
  if (last !== null) {
    console.log(`[poller] last indexed block from db: ${last}`);
    return last;
  }
  const resolved = startBlock ?? Number(process.env.START_BLOCK ?? NaN);
  if (!Number.isNaN(resolved)) {
    console.log(`[poller] using explicit start block ${resolved}`);
    return resolved;
  }
  return resolveContractCreationBlock(publicClient, contractAddress);
}

async function fetchLogs(
  publicClient: PublicClient,
  contractAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ConfidentialTransferLog[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await publicClient.getLogs({
        address: contractAddress,
        event: confidentialTransferEvent,
        fromBlock,
        toBlock,
      })) as unknown as ConfidentialTransferLog[];
    } catch (err) {
      const isRateLimit =
        (err as { cause?: { code?: number } })?.cause?.code === -32005;

      if (!isRateLimit || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;

      console.warn(
        `[poller] rate limited (retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}), waiting ${RATE_LIMIT_RETRY_MS / 1000}s...`,
      );
      await sleep(RATE_LIMIT_RETRY_MS);
    }
  }
}

export async function storeLogs(
  db: Db,
  publicClient: PublicClient,
  logs: ConfidentialTransferLog[],
): Promise<void> {
  if (logs.length === 0) return;

  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
  console.log(
    `[poller] storing ${logs.length} logs from ${uniqueBlocks.length} unique blocks`,
  );
  const blockTimestamps = new Map<bigint, number>();
  for (let i = 0; i < uniqueBlocks.length; i += BLOCK_BATCH_SIZE) {
    const chunk = uniqueBlocks.slice(i, i + BLOCK_BATCH_SIZE);
    const blocks = await Promise.all(
      chunk.map((bn) => publicClient.getBlock({ blockNumber: bn })),
    );
    for (const b of blocks) {
      blockTimestamps.set(b.number, Number(b.timestamp));
    }
    if (i + BLOCK_BATCH_SIZE < uniqueBlocks.length) {
      await sleep(500);
    }
  }

  for (const log of logs) {
    insertTransfer(db, {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockTimestamp: blockTimestamps.get(log.blockNumber) ?? 0,
      eventType: "transfer",
      from: getAddress(log.args.from),
      to: getAddress(log.args.to),
      encryptedHandle: log.args.encryptedAmount,
    });
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

    const logs = await fetchLogs(publicClient, contractAddress, from, batchEnd);
    console.log(
      `[poller] fetched blocks ${from}–${batchEnd}, got ${logs.length} logs`,
    );
    await storeLogs(db, publicClient, logs);

    setLastIndexedBlock(db, Number(batchEnd));
    from = batchEnd + BigInt(1);

    await sleep(CHUNK_DELAY_MS);
  }

  console.log(`[poller] catch-up done, up to block ${safeHead}`);
}

async function poll(
  db: Db,
  publicClient: PublicClient,
  contractAddress: Address,
  startBlock?: number,
): Promise<void> {
  try {
    const safeHead = await getSafeHead(publicClient);
    setChainHeadBlock(db, Number(safeHead + BigInt(CONFIRMATION_DEPTH)));

    const last = await resolveStartBlock(
      db,
      publicClient,
      contractAddress,
      startBlock,
    );
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
  } catch (err) {
    console.error("[poller] error:", err);
  }
}

export function startPoller(
  db: Db,
  publicClient: PublicClient,
  contractAddress: Address,
  startBlock?: number,
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
