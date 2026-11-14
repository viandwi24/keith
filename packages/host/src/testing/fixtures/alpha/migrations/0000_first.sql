CREATE TABLE `plg_alpha_items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plg_alpha_items_title` ON `plg_alpha_items` (`title`);