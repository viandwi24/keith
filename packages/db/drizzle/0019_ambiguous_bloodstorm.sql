CREATE TABLE `room_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`speaker` text,
	`text` text,
	`data` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_events_kind_known" CHECK("room_events"."kind" IN ('say', 'keith', 'join', 'leave', 'remove', 'end', 'system', 'handoff', 'post'))
);
--> statement-breakpoint
CREATE INDEX `room_events_room_seq` ON `room_events` (`room_id`,`seq`);--> statement-breakpoint
CREATE INDEX `room_events_room_at` ON `room_events` (`room_id`,`at`);--> statement-breakpoint
CREATE TABLE `room_members` (
	`room_id` text NOT NULL,
	`person_id` text NOT NULL,
	`status` text NOT NULL,
	`invited_by` text,
	`invited_at` integer NOT NULL,
	`joined_at` integer,
	`left_at` integer,
	`leave_reason` text,
	PRIMARY KEY(`room_id`, `person_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_members_status_known" CHECK("room_members"."status" IN ('invited', 'active', 'declined', 'left', 'removed', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `room_members_person_status` ON `room_members` (`person_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_members_one_active` ON `room_members` (`person_id`) WHERE "room_members"."status" = 'active';--> statement-breakpoint
CREATE TABLE `room_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`person` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_requests_kind_known" CHECK("room_requests"."kind" IN ('remove', 'end', 'post')),
	CONSTRAINT "room_requests_status_known" CHECK("room_requests"."status" IN ('pending', 'confirmed', 'refused', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `room_requests_person_status` ON `room_requests` (`person`,`status`);--> statement-breakpoint
CREATE INDEX `room_requests_status_expires` ON `room_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`initiator` text NOT NULL,
	`state` text NOT NULL,
	`answer_mode` text DEFAULT 'addressed' NOT NULL,
	`window_minutes` integer DEFAULT 30 NOT NULL,
	`window_events` integer DEFAULT 200 NOT NULL,
	`transport` text DEFAULT 'text' NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`ended_by` text,
	`end_reason` text,
	CONSTRAINT "rooms_state_known" CHECK("rooms"."state" IN ('open', 'active', 'ended')),
	CONSTRAINT "rooms_answer_mode_known" CHECK("rooms"."answer_mode" IN ('addressed', 'every')),
	CONSTRAINT "rooms_transport_known" CHECK("rooms"."transport" IN ('text'))
);
