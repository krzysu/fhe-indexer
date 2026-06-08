CREATE TABLE `balances` (
	`address` text PRIMARY KEY NOT NULL,
	`cleartext_balance` integer,
	`balance_status` text DEFAULT 'unknown' NOT NULL,
	`last_updated_block` integer DEFAULT 0 NOT NULL,
	`pending_transfers_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
