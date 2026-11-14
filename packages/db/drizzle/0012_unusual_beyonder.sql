CREATE TABLE `eh_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	`next_fire_at` integer,
	`claimed_until` integer,
	`version` integer NOT NULL,
	`doc` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eh_schedules_due` ON `eh_schedules` (`state`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `eh_schedules_session` ON `eh_schedules` (`session_id`,`id`);