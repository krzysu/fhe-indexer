import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./connection.js";
import { transfers, decryptQueue } from "./schema.js";

export type DecryptJob = typeof decryptQueue.$inferSelect;

/**
 * Idempotent enqueue. The `transfer_id UNIQUE` constraint on
 * `decrypt_queue` means re-enqueues from the sweep are safe and won't
 * produce duplicate jobs.
 */
export function enqueueDecryptJob(
  db: Db,
  transferId: number,
  encryptedHandle: string,
  contractAddress: string,
): void {
  db.insert(decryptQueue)
    .values({
      transfer_id: transferId,
      encrypted_handle: encryptedHandle,
      contract_address: contractAddress,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Backoff schedule for failed decrypt attempts: 0 attempts → immediate,
 * 1 → 10s, 2 → 30s, 3+ → 90s (capped). Three retries cover ~2 minutes
 * total — long enough to ride out transient relayer hiccups, short enough
 * that truly-broken jobs don't sit forever.
 */
function getBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(10_000 * 3 ** (attempts - 1), 90_000);
}

/**
 * Checks three gates: not currently locked by another worker, hasn't
 * exhausted `max_attempts`, and either has never been attempted or
 * enough time has elapsed since the last attempt to satisfy the
 * exponential backoff. Called per-candidate inside `dequeueBatch`.
 */
function isJobReady(job: DecryptJob, now: number): boolean {
  if (job.locked_at) return false;
  if (job.attempts >= job.max_attempts) return false;
  if (!job.last_attempted_at) return true;
  const elapsed = now - new Date(job.last_attempted_at).getTime();
  return elapsed >= getBackoffMs(job.attempts);
}

/**
 * Picks up to `limit` ready jobs. Strategy:
 *   1. SELECT candidates from SQL: not exhausted AND not locked,
 *   2. filter by backoff in JS (push to SQL when queue grows — see DECISIONS.md),
 *   3. lock the chosen rows via `UPDATE ... SET locked_at = now()` so
 *      a second worker instance won't grab the same job.
 * Note: `locked_at` only protects within one process — single-instance safe,
 * needs advisory locks for multi-instance (see Q37 in INTERVIEW_QUESTIONS).
 */
export function dequeueBatch(db: Db, limit: number): DecryptJob[] {
  const candidates = db
    .select()
    .from(decryptQueue)
    .where(
      and(
        lt(decryptQueue.attempts, decryptQueue.max_attempts),
        isNull(decryptQueue.locked_at),
      ),
    )
    .orderBy(decryptQueue.attempts, decryptQueue.created_at)
    .limit(limit * 3)
    .all();

  const now = Date.now();
  const ready: DecryptJob[] = [];
  for (const job of candidates) {
    if (ready.length >= limit) break;
    if (isJobReady(job, now)) {
      ready.push(job);
    }
  }

  const nowISO = new Date().toISOString();
  for (const job of ready) {
    db.update(decryptQueue)
      .set({ locked_at: nowISO })
      .where(eq(decryptQueue.id, job.id))
      .run();
  }

  return ready;
}

/**
 * Releases the `locked_at` claim without changing `attempts` or
 * `last_attempted_at`. Currently unused — failed jobs go through
 * `requeueWithBackoff` (which clears the lock) and successful/no-rights
 * jobs go through `deleteQueueEntry` — but kept for future "lock timed
 * out, retry" logic.
 */
export function unlockJob(db: Db, id: number): void {
  db.update(decryptQueue)
    .set({ locked_at: null })
    .where(eq(decryptQueue.id, id))
    .run();
}

/**
 * Failure path: bumps `attempts`, clears the lock, sets `last_attempted_at`
 * (either now or `now + startDelayMs` for the longer 60s propagation
 * case), and records the error message. The job stays in the queue and
 * becomes ready again once `getBackoffMs(attempts)` has elapsed.
 */
export function requeueWithBackoff(
  db: Db,
  id: number,
  error: string,
  startDelayMs?: number,
): void {
  const baseTime = startDelayMs
    ? new Date(Date.now() + startDelayMs)
    : new Date();
  db.update(decryptQueue)
    .set({
      attempts: sql`${decryptQueue.attempts} + 1`,
      locked_at: null,
      last_attempted_at: baseTime.toISOString(),
      last_error: error,
    })
    .where(eq(decryptQueue.id, id))
    .run();
}

/** Terminal state reached: drop the queue row, leave the transfer alone. */
export function deleteQueueEntry(db: Db, id: number): void {
  db.delete(decryptQueue).where(eq(decryptQueue.id, id)).run();
}

/**
 * Powers the sweep: returns `pending` transfers that have no matching
 * queue row — i.e. orphans produced by reorg CASCADE deletes or any
 * other path that lost the queue row without going through the normal
 * `enqueue` flow.
 */
export function getPendingOrphanTransfers(
  db: Db,
): { id: number; encrypted_handle: string | null }[] {
  return db
    .select({
      id: transfers.id,
      encrypted_handle: transfers.encrypted_handle,
    })
    .from(transfers)
    .where(
      and(
        eq(transfers.decrypt_status, "pending"),
        sql`NOT EXISTS (SELECT 1 FROM ${decryptQueue} WHERE ${decryptQueue.transfer_id} = ${transfers.id})`,
      ),
    )
    .all();
}
