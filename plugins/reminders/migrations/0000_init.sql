CREATE TABLE `plg_reminders_items` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`text` text NOT NULL,
	`when_kind` text NOT NULL,
	`when_at` integer,
	`when_expr` text,
	`status` text NOT NULL,
	`ended_reason` text,
	`last_slot` integer,
	`last_fire_at` integer,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plg_reminders_items_creator` ON `plg_reminders_items` (`creator_id`,`status`);--> statement-breakpoint
CREATE INDEX `plg_reminders_items_recipient` ON `plg_reminders_items` (`recipient_id`,`status`);