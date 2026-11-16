CREATE TABLE `workspaces` (
	`person_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`doc` text NOT NULL,
	`updated_at` integer NOT NULL
);
