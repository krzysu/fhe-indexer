import type { Db } from "../db/connection.js";
import { enqueueDecryptJob, getPendingOrphanTransfers } from "../db/queue.js";

const SWEEP_INTERVAL = 600_000;

async function sweep(db: Db, contractAddress: string): Promise<void> {
  const orphans = getPendingOrphanTransfers(db);
  if (orphans.length === 0) return;

  for (const row of orphans) {
    if (row.encrypted_handle) {
      enqueueDecryptJob(db, row.id, row.encrypted_handle, contractAddress);
    }
  }

  console.log(`[sweep] re-enqueued ${orphans.length} pending transfers`);
}

export function startSweep(db: Db, contractAddress: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  async function tick() {
    if (!running) return;
    try {
      await sweep(db, contractAddress);
    } catch (err) {
      console.error("[sweep] error:", err);
    }
    timer = setTimeout(tick, SWEEP_INTERVAL);
  }

  timer = setTimeout(tick, SWEEP_INTERVAL);

  return () => {
    running = false;
    if (timer) clearTimeout(timer);
  };
}
