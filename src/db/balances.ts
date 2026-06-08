import { eq, sql } from "drizzle-orm";
import type { Db } from "./connection.js";
import { balances } from "./schema.js";
import type { TransferRow } from "./transfers.js";

export type BalanceRow = typeof balances.$inferSelect;

export function getBalance(db: Db, address: string): BalanceRow | undefined {
  return db.select().from(balances).where(eq(balances.address, address)).get();
}

export function updateBalanceForTransfer(db: Db, transfer: TransferRow): void {
  const amount = transfer.cleartext_amount ?? 0;
  const isPending = transfer.decrypt_status === "pending";

  if (transfer.event_type === "shield") {
    updateBalance(
      db,
      transfer.to_address,
      amount,
      isPending,
      transfer.block_number,
    );
  } else if (transfer.event_type === "unshield") {
    updateBalance(
      db,
      transfer.from_address,
      -amount,
      isPending,
      transfer.block_number,
    );
  } else {
    updateBalance(
      db,
      transfer.from_address,
      -amount,
      isPending,
      transfer.block_number,
    );
    updateBalance(
      db,
      transfer.to_address,
      amount,
      isPending,
      transfer.block_number,
    );
  }
}

function updateBalance(
  db: Db,
  address: string,
  delta: number,
  hasPending: boolean,
  blockNumber: number,
): void {
  const existing = getBalance(db, address);

  if (!existing) {
    db.insert(balances)
      .values({
        address,
        cleartext_balance: delta,
        balance_status: hasPending ? "partial" : "complete",
        last_updated_block: blockNumber,
        pending_transfers_count: hasPending ? 1 : 0,
      })
      .run();
    return;
  }

  const newBalance = (existing.cleartext_balance ?? 0) + delta;
  const pendingDelta = hasPending ? 1 : 0;
  const newPendingCount = existing.pending_transfers_count + pendingDelta;
  const newStatus = newPendingCount > 0 ? "partial" : "complete";

  db.update(balances)
    .set({
      cleartext_balance: newBalance,
      balance_status: newStatus,
      last_updated_block: Math.max(existing.last_updated_block, blockNumber),
      pending_transfers_count: newPendingCount,
      updated_at: sql`(datetime('now'))`,
    })
    .where(eq(balances.address, address))
    .run();
}

export function markTransferDecrypted(db: Db, transfer: TransferRow): void {
  const cleartextAmount = transfer.cleartext_amount ?? 0;
  const entries = [
    { address: transfer.from_address, delta: -cleartextAmount },
    { address: transfer.to_address, delta: cleartextAmount },
  ];

  for (const { address, delta } of entries) {
    const existing = getBalance(db, address);
    if (existing && existing.pending_transfers_count > 0) {
      const newBalance = (existing.cleartext_balance ?? 0) + delta;
      const newPendingCount = existing.pending_transfers_count - 1;
      db.update(balances)
        .set({
          cleartext_balance: newBalance,
          pending_transfers_count: newPendingCount,
          balance_status: newPendingCount > 0 ? "partial" : "complete",
          updated_at: sql`(datetime('now'))`,
        })
        .where(eq(balances.address, address))
        .run();
    }
  }
}
