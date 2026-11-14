CREATE TABLE `resource_acl` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text DEFAULT '' NOT NULL,
	`bits` integer NOT NULL,
	`effect` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `id`, `subject_kind`, `subject_id`, `effect`),
	FOREIGN KEY (`kind`,`id`) REFERENCES `resources`(`kind`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resource_acl_subject` ON `resource_acl` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`person_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `person_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `group_members_person` ON `group_members` (`person_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `resources` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`group_id` text,
	`mode` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE INDEX `resources_owner_kind` ON `resources` (`owner_id`,`kind`);--> statement-breakpoint
CREATE INDEX `resources_group` ON `resources` (`group_id`);