CREATE TABLE `indexer_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tx_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`block_number` integer NOT NULL,
	`block_timestamp` integer NOT NULL,
	`event_type` text NOT NULL,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`encrypted_handle` text,
	`cleartext_amount` integer,
	`decrypt_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unq_tx_hash_log_index` ON `transfers` (`tx_hash`,`log_index`);