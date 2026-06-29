import type { Db } from "../db/connection.js";
import { enqueueDecryptJob, getPendingOrphanTransfers } from "../db/queue.js";

/**
 * How often the orphan-recovery sweep runs. Deliberately long (10 min):
 * recovery of orphans is not latency-sensitive and we don't want to hammer
 * the `decrypt_queue` table with duplicate-enqueue checks.
 */
const SWEEP_INTERVAL = 600_000;

/**
 * Finds `transfers` rows whose `decrypt_status = 'pending'` but which have
 * no matching row in `decrypt_queue` (orphans produced by reorg CASCADE
 * deletes, missed enqueues, or DB recovery) and re-enqueues them.
 * The `(transfer_id UNIQUE)` constraint on the queue makes this safe to
 * run concurrently with the poller.
 */
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

/**
 * Bootstraps the sweep loop on its 10-minute interval. Errors are caught
 * so a single bad tick doesn't kill the loop. Returns a stop function
 * for the shutdown handler.
 */
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
