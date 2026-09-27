CREATE TABLE `auth_tokens` (
	`token_hash` text PRIMARY KEY,
	`person_id` text NOT NULL,
	`node_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_auth_tokens_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `commitments` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`person_id` text NOT NULL,
	`task_id` text NOT NULL,
	`promise` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_commitments_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`),
	CONSTRAINT `fk_commitments_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_commitments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`author_person_id` text,
	`source` text NOT NULL,
	`urgency` text NOT NULL,
	`content` text NOT NULL,
	`ui` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	CONSTRAINT `fk_deliveries_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`),
	CONSTRAINT `fk_deliveries_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_deliveries_author_person_id_persons_id_fk` FOREIGN KEY (`author_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`subject_person_id` text,
	`visibility` text NOT NULL,
	`thread_id` text,
	`source` text NOT NULL,
	`author_person_id` text,
	`pinned` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_recalled_at` integer,
	CONSTRAINT `fk_memories_subject_person_id_persons_id_fk` FOREIGN KEY (`subject_person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_memories_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`),
	CONSTRAINT `fk_memories_author_person_id_persons_id_fk` FOREIGN KEY (`author_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
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
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_messages_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_messages_author_person_id_persons_id_fk` FOREIGN KEY (`author_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`capabilities` text NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE TABLE `persons` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`username` text UNIQUE,
	`password_hash` text,
	`tier` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugin_data` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `plugin_data_pk` PRIMARY KEY(`plugin_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `relationships` (
	`person_id` text PRIMARY KEY,
	`tone` text NOT NULL,
	`notes` text NOT NULL,
	`blocked_relay_from` text NOT NULL,
	CONSTRAINT `fk_relationships_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY,
	`person_id` text NOT NULL,
	`thread_id` text,
	`agent_id` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`summary` text,
	`detail` text,
	`ui` text,
	`visibility` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT `fk_tasks_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_tasks_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`)
);
--> statement-breakpoint
CREATE TABLE `thread_participants` (
	`thread_id` text NOT NULL,
	`person_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	CONSTRAINT `thread_participants_pk` PRIMARY KEY(`thread_id`, `person_id`),
	CONSTRAINT `fk_thread_participants_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_thread_participants_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`slug` text,
	`title` text NOT NULL,
	`owner_person_id` text,
	`summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_threads_owner_person_id_persons_id_fk` FOREIGN KEY (`owner_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE INDEX `auth_tokens_expires_at_idx` ON `auth_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `commitments_task_idx` ON `commitments` (`task_id`);--> statement-breakpoint
CREATE INDEX `commitments_thread_status_idx` ON `commitments` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `commitments_status_expires_idx` ON `commitments` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `deliveries_thread_status_idx` ON `deliveries` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `memories_visibility_idx` ON `memories` (`visibility`);--> statement-breakpoint
CREATE INDEX `memories_subject_idx` ON `memories` (`subject_person_id`);--> statement-breakpoint
CREATE INDEX `memories_thread_idx` ON `memories` (`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_thread_created_idx` ON `messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_status_created_idx` ON `tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_person_status_idx` ON `tasks` (`person_id`,`status`);--> statement-breakpoint
CREATE INDEX `thread_participants_person_idx` ON `thread_participants` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `threads_owner_slug_idx` ON `threads` (`owner_person_id`,`slug`);