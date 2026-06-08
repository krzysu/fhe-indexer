import "reflect-metadata";
import { config } from "dotenv";
config();

import type { Address, PublicClient } from "viem";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { Db } from "./db/connection.js";
import { initDb, closeDb } from "./db/connection.js";
import { startPoller } from "./indexer/poll.js";
import { createNestServer } from "./api/main.js";
import { initSdk, terminateSdk } from "./worker/sdk.js";
import { startWorker } from "./worker/worker.js";
import { startSweep } from "./worker/sweep.js";
import {
  setContractAddress,
  setTokenDecimals,
  setTokenSymbol,
} from "./db/state.js";

interface Env {
  rpcUrl: string;
  contractAddress: Address;
  privateKey?: string;
  startBlock: number;
  port: string;
}

function readEnv(): Env {
  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    console.error("SEPOLIA_RPC_URL is required");
    process.exit(1);
  }

  const contractAddress = process.env.CONTRACT_ADDRESS as Address | undefined;
  if (!contractAddress) {
    console.error("CONTRACT_ADDRESS is required");
    process.exit(1);
  }

  const rawStart = process.env.START_BLOCK;
  if (!rawStart) {
    console.error("START_BLOCK is required");
    process.exit(1);
  }
  const startBlock = Number(rawStart);
  if (Number.isNaN(startBlock)) {
    console.error("START_BLOCK must be a valid number");
    process.exit(1);
  }

  return {
    rpcUrl,
    contractAddress,
    privateKey: process.env.INDEXER_PRIVATE_KEY,
    startBlock,
    port: process.env.PORT ?? "3000",
  };
}

function setupDatabase(): Db {
  const db = initDb();
  console.log("[indexer] database initialized");
  return db;
}

function setupClients(rpcUrl: string) {
  const publicClient: PublicClient = createPublicClient({
    batch: {
      multicall: { batchSize: 10, wait: 16 },
    },
    chain: sepolia,
    transport: http(rpcUrl, {
      retryCount: 3,
      retryDelay: 2_000,
    }),
  });
  return { publicClient };
}

async function fetchTokenMetadata(
  publicClient: PublicClient,
  contractAddress: Address,
): Promise<{ decimals: number; symbol: string }> {
  const decimals = await publicClient.readContract({
    address: contractAddress,
    abi: [
      {
        name: "decimals",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
      },
    ],
    functionName: "decimals",
  });

  const symbol = await publicClient.readContract({
    address: contractAddress,
    abi: [
      {
        name: "symbol",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
      },
    ],
    functionName: "symbol",
  });

  return { decimals: Number(decimals), symbol };
}

function setupIndexer(
  db: Db,
  publicClient: PublicClient,
  env: Env,
): () => void {
  return startPoller(db, publicClient, env.contractAddress, env.startBlock);
}

function setupWorker(
  db: Db,
  env: Env,
): {
  stopWorker: (() => void) | undefined;
  stopSweep: (() => void) | undefined;
} {
  if (!env.privateKey) {
    console.log(
      "[indexer] INDEXER_PRIVATE_KEY not set, decrypt worker disabled",
    );
    return { stopWorker: undefined, stopSweep: undefined };
  }

  try {
    const sdk = initSdk(env.rpcUrl, env.privateKey);
    const stopWorker = startWorker(db, sdk);
    const stopSweep = startSweep(db, env.contractAddress);
    console.log("[indexer] decrypt worker started");
    return { stopWorker, stopSweep };
  } catch (err) {
    console.error("[indexer] failed to initialize SDK:", err);
    return { stopWorker: undefined, stopSweep: undefined };
  }
}

async function startServer(db: Db, port: string) {
  const app = await createNestServer(db);
  await app.listen(port);
  console.log(`[indexer] listening on port ${port}`);
  return app;
}

async function main() {
  const env = readEnv();
  const db = setupDatabase();
  setContractAddress(db, env.contractAddress);
  const { publicClient } = setupClients(env.rpcUrl);

  try {
    const { decimals, symbol } = await fetchTokenMetadata(
      publicClient,
      env.contractAddress,
    );
    setTokenDecimals(db, decimals);
    setTokenSymbol(db, symbol);
    console.log(`[indexer] token metadata: ${symbol} (${decimals} decimals)`);
  } catch (err) {
    console.warn(
      "[indexer] failed to fetch token metadata, using defaults:",
      err,
    );
  }

  const stopPoller = setupIndexer(db, publicClient, env);
  const { stopWorker, stopSweep } = setupWorker(db, env);
  const app = await startServer(db, env.port);

  const shutdown = () => {
    console.log("[indexer] shutting down...");
    stopPoller();
    if (stopWorker) stopWorker();
    if (stopSweep) stopSweep();
    terminateSdk();
    app.close();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[indexer] fatal error:", err);
  process.exit(1);
});
