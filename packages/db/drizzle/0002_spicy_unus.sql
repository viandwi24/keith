CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`arch` text NOT NULL,
	`version` text NOT NULL,
	`manifest` text NOT NULL,
	`allow_shell` integer DEFAULT 0 NOT NULL,
	`token_hash` text NOT NULL,
	`status` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_token_hash_unique` ON `nodes` (`token_hash`);--> statement-breakpoint
CREATE INDEX `nodes_name` ON `nodes` (`name`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_node` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pairing_codes_expiry` ON `pairing_codes` (`expires_at`);