import type { Db } from "./connection.js";

export function getLastIndexedBlock(db: Db): number | null {
  const row = db
    .prepare(`SELECT value FROM indexer_state WHERE key = 'last_indexed_block'`)
    .get() as { value: string } | undefined;

  return row ? Number(row.value) : null;
}

export function setLastIndexedBlock(db: Db, block: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO indexer_state (key, value) VALUES ('last_indexed_block', ?)`,
  ).run(String(block));
}

export function setChainHeadBlock(db: Db, block: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO indexer_state (key, value) VALUES ('chain_head_block', ?)`,
  ).run(String(block));
}

export function getChainHeadBlock(db: Db): number | null {
  const row = db
    .prepare(`SELECT value FROM indexer_state WHERE key = 'chain_head_block'`)
    .get() as { value: string } | undefined;

  return row ? Number(row.value) : null;
}
