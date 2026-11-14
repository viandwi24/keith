CREATE TABLE `catalog_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `client_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`hash` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_tokens_hash_unique` ON `client_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `client_tokens_person` ON `client_tokens` (`person_id`);--> statement-breakpoint
CREATE TABLE `config_profiles` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`definition_id` text NOT NULL,
	`label` text NOT NULL,
	`settings` text NOT NULL,
	`models` text,
	`extra` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `eh_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_by` text,
	`claimed_until` integer,
	`available_at` integer,
	`delayed_until` integer,
	`last_error` text,
	`dead_at` integer,
	`dead_reason` text
);
--> statement-breakpoint
CREATE INDEX `eh_inbox_session` ON `eh_inbox` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `eh_inbox_keys` (
	`session_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`item_id` text NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`session_id`, `dedupe_key`)
);
--> statement-breakpoint
CREATE INDEX `eh_inbox_keys_item` ON `eh_inbox_keys` (`item_id`);--> statement-breakpoint
CREATE INDEX `eh_inbox_keys_expiry` ON `eh_inbox_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `eh_locks` (
	`session_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eh_messages` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `eh_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`rev` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
