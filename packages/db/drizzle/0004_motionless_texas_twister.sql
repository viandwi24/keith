CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`via` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_at` ON `audit_events` (`at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`last_ip` text,
	`revoked_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `credentials_person` ON `credentials` (`person_id`);--> statement-breakpoint
CREATE TABLE `device_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`poll_hash` text NOT NULL,
	`label` text NOT NULL,
	`ip` text NOT NULL,
	`status` text NOT NULL,
	`credential_id` text,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_requests_code_hash_unique` ON `device_requests` (`code_hash`);--> statement-breakpoint
CREATE INDEX `device_requests_ip` ON `device_requests` (`ip`,`expires_at`);