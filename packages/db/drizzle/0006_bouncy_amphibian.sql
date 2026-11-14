CREATE TABLE `auth_attempts` (
	`subject` text NOT NULL,
	`ip` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer NOT NULL,
	`locked_at` integer,
	PRIMARY KEY(`subject`, `ip`)
);
--> statement-breakpoint
CREATE TABLE `person_secrets` (
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `kind`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `credentials` ADD `elevated_until` integer;