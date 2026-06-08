CREATE TABLE `decrypt_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transfer_id` integer NOT NULL,
	`encrypted_handle` text NOT NULL,
	`contract_address` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`last_error` text,
	`last_attempted_at` text,
	`locked_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `transfers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decrypt_queue_transfer_id_unique` ON `decrypt_queue` (`transfer_id`);