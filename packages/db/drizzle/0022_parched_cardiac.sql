CREATE TABLE `dream_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`trigger` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`counts` text DEFAULT '{}' NOT NULL,
	`cursor` text DEFAULT '{}' NOT NULL,
	`undo_until` integer,
	CONSTRAINT "dream_runs_trigger_known" CHECK("dream_runs"."trigger" IN ('schedule', 'manual')),
	CONSTRAINT "dream_runs_mode_known" CHECK("dream_runs"."mode" IN ('off', 'propose', 'auto')),
	CONSTRAINT "dream_runs_status_known" CHECK("dream_runs"."status" IN ('running', 'applied', 'staged', 'skipped', 'refused', 'failed', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `dream_runs_person_started` ON `dream_runs` (`person_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `dream_settings` (
	`person_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "dream_settings_mode_known" CHECK("dream_settings"."mode" IN ('off', 'propose', 'auto'))
);
