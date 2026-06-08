import { eq } from "drizzle-orm";
import type { Db } from "./connection.js";
import { indexerState } from "./schema.js";

function getState(db: Db, key: string): string | undefined {
  const row = db
    .select({ value: indexerState.value })
    .from(indexerState)
    .where(eq(indexerState.key, key))
    .get();

  return row?.value;
}

function setState(db: Db, key: string, value: string): void {
  db.insert(indexerState)
    .values({ key, value })
    .onConflictDoUpdate({ target: indexerState.key, set: { value } })
    .run();
}

export function getLastIndexedBlock(db: Db): number | null {
  const val = getState(db, "last_indexed_block");
  return val ? Number(val) : null;
}

export function setLastIndexedBlock(db: Db, block: number): void {
  setState(db, "last_indexed_block", String(block));
}

export function getLastIndexedHash(db: Db): string | null {
  return getState(db, "last_indexed_hash") ?? null;
}

export function setLastIndexedHash(db: Db, hash: string): void {
  setState(db, "last_indexed_hash", hash);
}

export function getStartBlock(db: Db): number | null {
  const val = getState(db, "start_block");
  return val ? Number(val) : null;
}

export function setStartBlock(db: Db, block: number): void {
  setState(db, "start_block", String(block));
}

export function getChainHeadBlock(db: Db): number | null {
  const val = getState(db, "chain_head_block");
  return val ? Number(val) : null;
}

export function setChainHeadBlock(db: Db, block: number): void {
  setState(db, "chain_head_block", String(block));
}

export function getContractAddress(db: Db): string | null {
  return getState(db, "contract_address") ?? null;
}

export function setContractAddress(db: Db, address: string): void {
  setState(db, "contract_address", address);
}
