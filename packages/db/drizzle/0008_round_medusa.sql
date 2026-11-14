CREATE TABLE `person_identifiers` (
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`value_norm` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `person_identifiers_person` ON `person_identifiers` (`person_id`);--> statement-breakpoint
ALTER TABLE `credentials` ADD `methods` text;--> statement-breakpoint
ALTER TABLE `credentials` ADD `assurance` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `credentials` ADD `idle_expires_at` integer;--> statement-breakpoint
ALTER TABLE `credentials` ADD `absolute_expires_at` integer;--> statement-breakpoint
ALTER TABLE `credentials` ADD `user_agent` text;--> statement-breakpoint
ALTER TABLE `credentials` ADD `revoked_reason` text;--> statement-breakpoint
ALTER TABLE `people` ADD `can_login` integer DEFAULT 1 NOT NULL;