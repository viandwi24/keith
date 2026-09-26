CREATE TABLE `files` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`owner_person_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_files_owner_person_id_persons_id_fk` FOREIGN KEY (`owner_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE INDEX `files_owner_idx` ON `files` (`owner_person_id`);