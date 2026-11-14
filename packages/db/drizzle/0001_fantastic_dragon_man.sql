CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`agent_id` text,
	`session_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_type` ON `events` (`type`,`seq`);--> statement-breakpoint
CREATE INDEX `events_session` ON `events` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_session_id` text NOT NULL,
	`agent` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`steps` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `tasks_parent` ON `tasks` (`parent_session_id`,`updated_at`);