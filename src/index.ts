import "reflect-metadata";
import { config } from "dotenv";
config();

import { type Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { initDb, closeDb } from "./db/connection.js";
import { startPoller } from "./indexer/poll.js";
import { createNestServer } from "./api/main.js";

async function main() {
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

  const db = initDb();

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { batch: true }),
  });

  const stopPoller = startPoller(db, publicClient, contractAddress);

  const app = await createNestServer(db);
  const port = process.env.PORT ?? "3000";
  await app.listen(port);

  console.log(`[indexer] listening on port ${port}`);

  const shutdown = () => {
    console.log("[indexer] shutting down...");
    stopPoller();
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
