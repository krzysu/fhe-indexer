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
}

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
    })
    .onConflictDoNothing()
    .run();

  if (result.changes === 0) return undefined;
  return Number(result.lastInsertRowid);
}

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

export function deleteTransfersAfter(db: Db, blockNumber: number): void {
  db.delete(transfers)
    .where(gt(transfers.block_number, blockNumber))
    .run();
}

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

export function resetTransfersToPending(db: Db, ids: number[]): void {
  if (ids.length === 0) return;
  db.update(transfers)
    .set({ decrypt_status: "pending" })
    .where(inArray(transfers.id, ids))
    .run();
}
