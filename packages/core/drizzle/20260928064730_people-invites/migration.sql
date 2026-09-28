CREATE TABLE `invite_links` (
	`code_hash` text PRIMARY KEY,
	`person_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	CONSTRAINT `fk_invite_links_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `thread_invitations` (
	`thread_id` text NOT NULL,
	`person_id` text NOT NULL,
	`invited_by` text NOT NULL,
	`status` text NOT NULL,
	`delivery_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	CONSTRAINT `thread_invitations_pk` PRIMARY KEY(`thread_id`, `person_id`),
	CONSTRAINT `fk_thread_invitations_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_thread_invitations_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_thread_invitations_invited_by_persons_id_fk` FOREIGN KEY (`invited_by`) REFERENCES `persons`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_thread_invitations_delivery_id_deliveries_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `threads` ADD `purpose` text;--> statement-breakpoint
CREATE INDEX `invite_links_person_idx` ON `invite_links` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `persons_name_lower_idx` ON `persons` (lower("name"));--> statement-breakpoint
CREATE INDEX `thread_invitations_person_status_idx` ON `thread_invitations` (`person_id`,`status`);