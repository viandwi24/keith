CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`capabilities` text NOT NULL,
	`version` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_active_at` integer
);
--> statement-breakpoint
CREATE INDEX `clients_person` ON `clients` (`person_id`);--> statement-breakpoint
CREATE TABLE `presence_disclosure` (
	`person_id` text NOT NULL,
	`audience` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`person_id`, `audience`)
);
--> statement-breakpoint
CREATE TABLE `presence_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`client_id` text,
	`type` text NOT NULL,
	`at` integer NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `presence_signals_person_at` ON `presence_signals` (`person_id`,`at`);--> statement-breakpoint
CREATE TABLE `presence_status` (
	`person_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`note` text,
	`until` integer,
	`set_at` integer NOT NULL
);
