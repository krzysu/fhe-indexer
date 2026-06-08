import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const transfers = sqliteTable(
  "transfers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tx_hash: text("tx_hash").notNull(),
    log_index: integer("log_index").notNull(),
    block_number: integer("block_number").notNull(),
    block_timestamp: integer("block_timestamp").notNull(),
    event_type: text("event_type", {
      enum: ["transfer", "shield", "unshield"],
    }).notNull(),
    from_address: text("from_address").notNull(),
    to_address: text("to_address").notNull(),
    encrypted_handle: text("encrypted_handle"),
    cleartext_amount: integer("cleartext_amount"),
    decrypt_status: text("decrypt_status", {
      enum: ["plain", "pending", "decrypted", "no_rights"],
    })
      .notNull()
      .default("pending"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    unqTxHashLogIndex: uniqueIndex("unq_tx_hash_log_index").on(
      table.tx_hash,
      table.log_index,
    ),
  }),
);

export type TransferEventType = (typeof transfers.$inferInsert)["event_type"];
export type TransferDecryptStatus =
  (typeof transfers.$inferInsert)["decrypt_status"];

export const indexerState = sqliteTable("indexer_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
