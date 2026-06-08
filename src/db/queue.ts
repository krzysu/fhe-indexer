import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./connection.js";
import { transfers, decryptQueue } from "./schema.js";

export type DecryptJob = typeof decryptQueue.$inferSelect;

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

function getBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(10_000 * 3 ** (attempts - 1), 90_000);
}

function isJobReady(job: DecryptJob, now: number): boolean {
  if (job.locked_at) return false;
  if (job.attempts >= job.max_attempts) return false;
  if (!job.last_attempted_at) return true;
  const elapsed = now - new Date(job.last_attempted_at).getTime();
  return elapsed >= getBackoffMs(job.attempts);
}

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

export function unlockJob(db: Db, id: number): void {
  db.update(decryptQueue)
    .set({ locked_at: null })
    .where(eq(decryptQueue.id, id))
    .run();
}

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

export function deleteQueueEntry(db: Db, id: number): void {
  db.delete(decryptQueue).where(eq(decryptQueue.id, id)).run();
}

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
