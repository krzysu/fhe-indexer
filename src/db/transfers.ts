import { sql } from "drizzle-orm";
import { eq, or } from "drizzle-orm";
import type { Db } from "./connection.js";
import { transfers, type TransferEventType } from "./schema.js";

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

export function insertTransfer(db: Db, input: InsertTransferInput): void {
  db.insert(transfers)
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
