PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`author_person_id` text,
	`node_id` text,
	`modality` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`tool_call_id` text,
	`tool_name` text,
	`is_error` integer,
	`ui` text,
	`meta` text,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_messages_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_messages_author_person_id_persons_id_fk` FOREIGN KEY (`author_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_messages`(`id`, `thread_id`, `role`, `author_person_id`, `node_id`, `modality`, `content`, `tool_calls`, `tool_call_id`, `tool_name`, `is_error`, `ui`, `meta`, `seq`, `created_at`) SELECT `id`, `thread_id`, `role`, `author_person_id`, `node_id`, `modality`, `content`, `tool_calls`, `tool_call_id`, `tool_name`, `is_error`, `ui`, `meta`, `seq`, `created_at` FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `messages_thread_created_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_thread_seq_idx` ON `messages` (`thread_id`,`seq`);