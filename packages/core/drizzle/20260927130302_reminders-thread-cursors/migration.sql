CREATE TABLE `reminders` (
	`id` text PRIMARY KEY,
	`person_id` text NOT NULL,
	`thread_id` text,
	`text` text NOT NULL,
	`due_at` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`fired_at` integer,
	`cancelled_at` integer,
	`delivery_id` text,
	CONSTRAINT `fk_reminders_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_reminders_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_reminders_delivery_id_deliveries_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `threads` ADD `summary_through_seq` integer;--> statement-breakpoint
ALTER TABLE `threads` ADD `reflected_through_seq` integer;--> statement-breakpoint
CREATE INDEX `reminders_status_due_idx` ON `reminders` (`status`,`due_at`);