CREATE TABLE `person_grants` (
	`person_id` text NOT NULL,
	`capability` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `capability`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
