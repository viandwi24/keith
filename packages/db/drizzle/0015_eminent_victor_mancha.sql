CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`recipient_id` text NOT NULL,
	`bill_to` text,
	`name` text NOT NULL,
	`needs` text NOT NULL,
	`data` text,
	`text` text NOT NULL,
	`report_to` text,
	`report_text` text,
	`report_key` text,
	`status` text NOT NULL,
	`reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`route` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deliveries_due` ON `deliveries` (`status`,`next_attempt_at`);