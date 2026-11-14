CREATE TABLE `agenda_items` (
	`id` text PRIMARY KEY NOT NULL,
	`person` text NOT NULL,
	`what` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`place` text,
	`status` text NOT NULL,
	`source_session` text,
	`source_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agenda_items_person` ON `agenda_items` (`person`,`starts_at`);--> statement-breakpoint
CREATE TABLE `protocol_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`person` text NOT NULL,
	`definition` text NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `protocol_proposals_person` ON `protocol_proposals` (`person`,`status`);--> statement-breakpoint
CREATE INDEX `protocol_proposals_expiry` ON `protocol_proposals` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `protocol_run_steps` (
	`n` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`step` text NOT NULL,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`at` integer NOT NULL,
	`detail` text,
	FOREIGN KEY (`run_id`) REFERENCES `protocol_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `protocol_run_steps_run` ON `protocol_run_steps` (`run_id`,`n`);--> statement-breakpoint
CREATE TABLE `protocol_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`protocol_id` text NOT NULL,
	`version` integer NOT NULL,
	`person` text NOT NULL,
	`trigger_ref` text NOT NULL,
	`status` text NOT NULL,
	`step` text,
	`visits` text DEFAULT '{}' NOT NULL,
	`answers` text DEFAULT '{}' NOT NULL,
	`wake_at` integer,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_runs_trigger` ON `protocol_runs` (`protocol_id`,`trigger_ref`);--> statement-breakpoint
CREATE INDEX `protocol_runs_due` ON `protocol_runs` (`status`,`wake_at`);--> statement-breakpoint
CREATE INDEX `protocol_runs_person` ON `protocol_runs` (`person`,`started_at`);--> statement-breakpoint
CREATE TABLE `protocol_versions` (
	`protocol_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`approvals` text DEFAULT '[]' NOT NULL,
	`saved_by` text NOT NULL,
	`saved_at` integer NOT NULL,
	PRIMARY KEY(`protocol_id`, `version`),
	FOREIGN KEY (`protocol_id`) REFERENCES `protocols`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `protocols` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`built_in` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`paused_until` integer,
	`version` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocols_owner_name` ON `protocols` (`owner`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `protocols_owner_built_in` ON `protocols` (`owner`,`built_in`);