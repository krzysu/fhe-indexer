import { eq, sql } from "drizzle-orm";
import type { Db } from "./connection.js";
import { balances } from "./schema.js";
import type { TransferRow } from "./transfers.js";

export type BalanceRow = typeof balances.$inferSelect;

/** Single-row read used by `/balance/:address`. */
export function getBalance(db: Db, address: string): BalanceRow | undefined {
  return db.select().from(balances).where(eq(balances.address, address)).get();
}

/**
 * Poller-side write. Called from `storeLogs` for every event so the
 * balance is kept fresh as the chain is indexed. Sign convention:
 *   - shield:  `to_address += amount` (mint)
 *   - unshield: `from_address -= amount` (burn)
 *   - transfer: `from_address -= amount`, `to_address += amount`
 * For encrypted transfers `amount = 0` (no cleartext yet); we still
 * bump `pending_transfers_count` so the balance reads as `partial`.
 */
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

/**
 * Internal helper that does the actual UPSERT on `balances`. Called
 * twice per transfer (sender + receiver) for encrypted transfers, or
 * once for shield/unshield. Insert on first sight; on update, applies
 * the delta, recomputes `balance_status` from the new pending count,
 * and bumps `last_updated_block` if this event is newer.
 */
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

/**
 * Worker-side write: called after `delegatedDecrypt` succeeds. Applies
 * the real cleartext amount to both parties (negative for sender,
 * positive for receiver) and decrements `pending_transfers_count`.
 * When the count hits zero the row's status flips to `complete`.
 * Important invariant: this is the ONLY place that decrements
 * `pending_transfers_count` for an `encrypted_handle` transfer.
 */
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
