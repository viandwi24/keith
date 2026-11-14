CREATE TABLE `eh_budget_record` (
	`key` text PRIMARY KEY NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eh_budget_reservation` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`scopes` text NOT NULL,
	`period_start` integer NOT NULL,
	`amount_usd` text NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eh_budget_reservation_key` ON `eh_budget_reservation` (`key`);--> statement-breakpoint
CREATE TABLE `eh_budget_scope` (
	`scope` text NOT NULL,
	`period_start` integer NOT NULL,
	`limit_usd` text,
	`spent_usd` text DEFAULT '0' NOT NULL,
	PRIMARY KEY(`scope`, `period_start`)
);
--> statement-breakpoint
CREATE TABLE `eh_stream_chunks` (
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`idx` integer NOT NULL,
	`chunk` text NOT NULL,
	PRIMARY KEY(`session_id`, `turn_id`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `eh_stream_log` (
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`status` text NOT NULL,
	`length` integer DEFAULT 0 NOT NULL,
	`ttl_ms` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `eh_stream_log_expiry` ON `eh_stream_log` (`expires_at`);