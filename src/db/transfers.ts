import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Db } from "./connection.js";
import {
  transfers,
  type TransferEventType,
  type TransferDecryptStatus,
} from "./schema.js";

export type TransferRow = typeof transfers.$inferSelect;

export interface InsertTransferInput {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: number;
  eventType: TransferEventType;
  from: string;
  to: string;
  encryptedHandle: string | null;
  cleartextAmount?: bigint;
  decryptStatus?: TransferDecryptStatus;
}

/**
 * Inserts a single parsed event. Returns the new row's id, or `undefined`
 * if the insert was a no-op (the `(tx_hash, log_index)` unique constraint
 * already has a row — i.e. we re-indexed this log).
 * Idempotency here is what makes reorg rollback safe to retry.
 */
export function insertTransfer(
  db: Db,
  input: InsertTransferInput,
): number | undefined {
  const result = db
    .insert(transfers)
    .values({
      tx_hash: input.txHash,
      log_index: input.logIndex,
      block_number: Number(input.blockNumber),
      block_timestamp: input.blockTimestamp,
      event_type: input.eventType,
      from_address: input.from,
      to_address: input.to,
      encrypted_handle: input.encryptedHandle,
      ...(input.cleartextAmount !== undefined && {
        cleartext_amount: Number(input.cleartextAmount),
      }),
      ...(input.decryptStatus !== undefined && {
        decrypt_status: input.decryptStatus,
      }),
    })
    .onConflictDoNothing()
    .run();

  if (result.changes === 0) return undefined;
  return Number(result.lastInsertRowid);
}

/**
 * Worker-side write: transitions a `pending`/`no_rights` row to a new
 * `decrypt_status` and, on `decrypted`, populates `cleartext_amount`.
 * Does NOT touch the `balances` table — that's `markTransferDecrypted`'s job.
 */
export function updateTransferDecryptStatus(
  db: Db,
  id: number,
  status: TransferDecryptStatus,
  cleartextAmount?: bigint,
): void {
  db.update(transfers)
    .set({
      decrypt_status: status,
      ...(cleartextAmount !== undefined && {
        cleartext_amount: Number(cleartextAmount),
      }),
    })
    .where(eq(transfers.id, id))
    .run();
}

/**
 * Paginated all-transfers fetch (debug endpoint). Ordered by `block_number DESC`
 * so the newest events surface first. Returns rows + total count so the
 * controller can compute `totalPages`.
 */
export function getAllTransfers(
  db: Db,
  page: number,
  limit: number,
): { rows: TransferRow[]; total: number } {
  const offset = (page - 1) * limit;

  const total = db
    .select({ count: sql<number>`count(*)` })
    .from(transfers)
    .get();

  const rows = db
    .select()
    .from(transfers)
    .orderBy(sql`block_number DESC`)
    .limit(limit)
    .offset(offset)
    .all();

  return { rows, total: total?.count ?? 0 };
}

/**
 * Paginated transfers where the address is either sender or receiver
 * (including shield/unshield rows). Same ordering as `getAllTransfers`.
 */
export function getTransfersByAddress(
  db: Db,
  address: string,
  page: number,
  limit: number,
): { rows: TransferRow[]; total: number } {
  const offset = (page - 1) * limit;

  const condition = or(
    eq(transfers.from_address, address),
    eq(transfers.to_address, address),
  );

  const total = db
    .select({ count: sql<number>`count(*)` })
    .from(transfers)
    .where(condition)
    .get();

  const rows = db
    .select()
    .from(transfers)
    .where(condition)
    .orderBy(sql`block_number DESC`)
    .limit(limit)
    .offset(offset)
    .all();

  return { rows, total: total?.count ?? 0 };
}

/**
 * Reorg rollback: deletes every transfer above `blockNumber`. The
 * `decrypt_queue.transfer_id` FK has `ON DELETE CASCADE`, so queue rows
 * for those transfers are purged automatically — no manual cleanup.
 */
export function deleteTransfersAfter(db: Db, blockNumber: number): void {
  db.delete(transfers).where(gt(transfers.block_number, blockNumber)).run();
}

/**
 * Lightweight projection used by the decrypt worker — only needs
 * `from_address`/`to_address` to pick a delegator for `delegatedDecrypt`.
 */
export function getTransferById(
  db: Db,
  id: number,
): { from_address: string; to_address: string } | undefined {
  return db
    .select({
      from_address: transfers.from_address,
      to_address: transfers.to_address,
    })
    .from(transfers)
    .where(eq(transfers.id, id))
    .get();
}

/**
 * Full-row read used by `markTransferDecrypted` to apply the balance
 * delta after a successful decrypt (needs from/to + amount).
 */
export function getFullTransferById(
  db: Db,
  id: number,
): TransferRow | undefined {
  return db.select().from(transfers).where(eq(transfers.id, id)).get();
}

/**
 * Powers the `/admin/retry-no-rights` endpoint: returns every
 * `decrypt_status = 'no_rights'` transfer, optionally narrowed to those
 * involving a specific address. Filters out rows missing an
 * `encrypted_handle` (shield/unshield never reach this status, but the
 * type system can't encode that).
 */
export function getNoRightsTransfers(
  db: Db,
  address?: string,
): { id: number; encrypted_handle: string }[] {
  const condition = address
    ? and(
        eq(transfers.decrypt_status, "no_rights"),
        or(
          eq(transfers.from_address, address),
          eq(transfers.to_address, address),
        ),
      )
    : eq(transfers.decrypt_status, "no_rights");
  const rows = db
    .select({ id: transfers.id, encrypted_handle: transfers.encrypted_handle })
    .from(transfers)
    .where(condition)
    .all();

  return rows.filter(
    (r): r is { id: number; encrypted_handle: string } =>
      r.encrypted_handle !== null,
  );
}

/**
 * Bulk reset of `decrypt_status` from terminal (`no_rights` or `decrypted`)
 * back to `pending`. Used by the admin retry endpoint after the partner
 * grants the indexer new ACL delegation rights.
 */
export function resetTransfersToPending(db: Db, ids: number[]): void {
  if (ids.length === 0) return;
  db.update(transfers)
    .set({ decrypt_status: "pending" })
    .where(inArray(transfers.id, ids))
    .run();
}
