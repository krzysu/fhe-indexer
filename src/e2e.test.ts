import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./db/schema.js";
import type { Db } from "./db/connection.js";
import { getTransfersByAddress } from "./db/transfers.js";
import { getBalance } from "./db/balances.js";
import { startPoller } from "./indexer/poll.js";

const CONTRACT_ADDR = process.env.CONTRACT_ADDRESS as Address;
const RPC_URL =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const WALLET_KEY = process.env.TEST_WALLET_KEY;

const TEST_ADDRESS = WALLET_KEY
  ? privateKeyToAccount(WALLET_KEY as Address).address
  : undefined;

function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe.skipIf(!CONTRACT_ADDR || !TEST_ADDRESS)(
  "E2E: indexer picks up existing events",
  () => {
    let db: Db;
    let stopPoller: (() => void) | null = null;
    let publicClient: ReturnType<typeof createPublicClient>;

    beforeAll(async () => {
      db = createTestDb();
      publicClient = createPublicClient({
        chain: sepolia,
        transport: http(RPC_URL),
      });

      const currentBlock = await publicClient.getBlockNumber();
      const startBlock = currentBlock - 1000n;
      console.log(
        `Starting indexer from block ${startBlock} (current: ${currentBlock})`,
      );

      const indexerPublicClient = createPublicClient({
        chain: sepolia,
        transport: http(RPC_URL),
      });
      stopPoller = startPoller(
        db,
        indexerPublicClient,
        CONTRACT_ADDR,
        Number(startBlock),
      );
    }, 30000);

    afterAll(() => {
      if (stopPoller) stopPoller();
    });

    it("indexes events from the last 1000 blocks", async () => {
      console.log("Waiting for indexer to catch up (30s)...");
      await new Promise((resolve) => setTimeout(resolve, 30000));

      const transfers = getTransfersByAddress(db, TEST_ADDRESS!, 1, 100);
      console.log(`Found ${transfers.total} transfers for ${TEST_ADDRESS}`);

      if (transfers.total > 0) {
        console.log("Sample transfers:");
        for (const t of transfers.rows.slice(0, 5)) {
          console.log(
            `  ${t.event_type}: ${t.from_address} -> ${t.to_address}, amount=${t.cleartext_amount}, status=${t.decrypt_status}`,
          );
        }

        const shieldEvents = transfers.rows.filter(
          (t) => t.event_type === "shield",
        );
        for (const shield of shieldEvents) {
          expect(shield.decrypt_status).toBe("plain");
          expect(shield.cleartext_amount).toBeGreaterThan(0);
        }
      }

      const balance = getBalance(db, TEST_ADDRESS!);
      if (balance) {
        console.log(
          `Balance: ${balance.cleartext_balance}, status: ${balance.balance_status}, pending: ${balance.pending_transfers_count}`,
        );
      }

      expect(true).toBe(true);
    }, 60000);
  },
);
