CREATE TABLE `plg_reminders_fires` (
	`fire_id` text PRIMARY KEY NOT NULL,
	`reminder_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`slot` integer NOT NULL,
	`fired_at` integer NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plg_reminders_fires_fired` ON `plg_reminders_fires` (`fired_at`);--> statement-breakpoint
CREATE INDEX `plg_reminders_fires_creator` ON `plg_reminders_fires` (`creator_id`,`fired_at`);