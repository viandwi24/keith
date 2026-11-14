CREATE TABLE `person_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`platform` text NOT NULL,
	`native_id` text NOT NULL,
	`label` text,
	`status` text NOT NULL,
	`linked_via` text NOT NULL,
	`linked_by` text,
	`linked_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `person_accounts_person` ON `person_accounts` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `person_accounts_linked` ON `person_accounts` (`platform`,`native_id`) WHERE "person_accounts"."status" = 'linked';--> statement-breakpoint
CREATE TABLE `person_pair_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `person_pair_codes_person` ON `person_pair_codes` (`person_id`,`expires_at`);--> statement-breakpoint
ALTER TABLE `people` ADD `username` text;--> statement-breakpoint
ALTER TABLE `people` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `nickname` text;--> statement-breakpoint
ALTER TABLE `people` ADD `notes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `fields` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `divisions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `member_id` text;--> statement-breakpoint
ALTER TABLE `people` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `people` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `people_username_unique` ON `people` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `people_one_owner` ON `people` (`role`) WHERE "people"."role" = 'owner';