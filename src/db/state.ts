import { eq } from "drizzle-orm";
import type { Db } from "./connection.js";
import { indexerState } from "./schema.js";

/**
 * Generic `indexer_state` key-value getter. The table holds all the
 * single-row checkpoints (last indexed block, last indexed hash, token
 * decimals/symbol, etc.) — anything that needs to survive a restart.
 */
function getState(db: Db, key: string): string | undefined {
  const row = db
    .select({ value: indexerState.value })
    .from(indexerState)
    .where(eq(indexerState.key, key))
    .get();

  return row?.value;
}

/**
 * Upsert into `indexer_state`. Used by every checkpoint writer in the
 * project (`setLastIndexedBlock`, `setTokenDecimals`, …) — keeping the
 * SQL in one place makes future changes (e.g. switching to a typed JSON
 * column) trivial.
 */
function setState(db: Db, key: string, value: string): void {
  db.insert(indexerState)
    .values({ key, value })
    .onConflictDoUpdate({ target: indexerState.key, set: { value } })
    .run();
}

/** Last block number whose events have been fully ingested. */
export function getLastIndexedBlock(db: Db): number | null {
  const val = getState(db, "last_indexed_block");
  return val ? Number(val) : null;
}

export function setLastIndexedBlock(db: Db, block: number): void {
  setState(db, "last_indexed_block", String(block));
}

/** Block hash at `last_indexed_block` — used for reorg detection. */
export function getLastIndexedHash(db: Db): string | null {
  return getState(db, "last_indexed_hash") ?? null;
}

export function setLastIndexedHash(db: Db, hash: string): void {
  setState(db, "last_indexed_hash", hash);
}

/** Persisted start block — frozen on first run so restarts are stable. */
export function getStartBlock(db: Db): number | null {
  const val = getState(db, "start_block");
  return val ? Number(val) : null;
}

export function setStartBlock(db: Db, block: number): void {
  setState(db, "start_block", String(block));
}

/** Most recent chain head observed by the poller (for `/health` lag calc). */
export function getChainHeadBlock(db: Db): number | null {
  const val = getState(db, "chain_head_block");
  return val ? Number(val) : null;
}

export function setChainHeadBlock(db: Db, block: number): void {
  setState(db, "chain_head_block", String(block));
}

/** ERC-7984 contract address we're indexing; cached for the API layer. */
export function getContractAddress(db: Db): string | null {
  return getState(db, "contract_address") ?? null;
}

export function setContractAddress(db: Db, address: string): void {
  setState(db, "contract_address", address);
}

/** Token decimals fetched once at startup, exposed via `/balance`. */
export function getTokenDecimals(db: Db): number | null {
  const val = getState(db, "token_decimals");
  return val ? Number(val) : null;
}

export function setTokenDecimals(db: Db, decimals: number): void {
  setState(db, "token_decimals", String(decimals));
}

/** Token symbol fetched once at startup, exposed via `/balance`. */
export function getTokenSymbol(db: Db): string | null {
  return getState(db, "token_symbol") ?? null;
}

export function setTokenSymbol(db: Db, symbol: string): void {
  setState(db, "token_symbol", symbol);
}
