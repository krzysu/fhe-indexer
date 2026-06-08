import type { Db } from "./connection.js";

export interface TransferRow {
  id: number;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: number;
  event_type: "transfer" | "shield" | "unshield";
  from_address: string;
  to_address: string;
  encrypted_handle: string | null;
  cleartext_amount: number | null;
  decrypt_status: "plain" | "pending" | "decrypted" | "no_rights";
  created_at: string;
}

export interface InsertTransferInput {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: number;
  eventType: "transfer" | "shield" | "unshield";
  from: string;
  to: string;
  encryptedHandle: string | null;
}

export function insertTransfer(db: Db, input: InsertTransferInput): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transfers
      (tx_hash, log_index, block_number, block_timestamp, event_type, from_address, to_address, encrypted_handle, cleartext_amount, decrypt_status)
    VALUES
      (@txHash, @logIndex, @blockNumber, @blockTimestamp, @eventType, @from, @to, @encryptedHandle, NULL, 'pending')
  `);

  stmt.run({
    txHash: input.txHash,
    logIndex: input.logIndex,
    blockNumber: Number(input.blockNumber),
    blockTimestamp: input.blockTimestamp,
    eventType: input.eventType,
    from: input.from,
    to: input.to,
    encryptedHandle: input.encryptedHandle,
  });
}

export function getAllTransfers(
  db: Db,
  page: number,
  limit: number,
): { rows: TransferRow[]; total: number } {
  const offset = (page - 1) * limit;

  const countRow = db
    .prepare("SELECT COUNT(*) as count FROM transfers")
    .get() as { count: number };

  const rows = db
    .prepare("SELECT * FROM transfers ORDER BY block_number DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as TransferRow[];

  return { rows, total: countRow.count };
}

export function getTransfersByAddress(
  db: Db,
  address: string,
  page: number,
  limit: number,
): { rows: TransferRow[]; total: number } {
  const offset = (page - 1) * limit;

  const countRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM transfers WHERE from_address = ? OR to_address = ?`,
    )
    .get(address, address) as { count: number };

  const rows = db
    .prepare(
      `SELECT * FROM transfers WHERE from_address = ? OR to_address = ? ORDER BY block_number DESC LIMIT ? OFFSET ?`,
    )
    .all(address, address, limit, offset) as TransferRow[];

  return { rows, total: countRow.count };
}
