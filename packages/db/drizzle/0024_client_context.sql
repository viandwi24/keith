CREATE TABLE `presence_client_context` (
	`person_id` text PRIMARY KEY NOT NULL,
	`share` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `clients` ADD `environment` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `network` text;