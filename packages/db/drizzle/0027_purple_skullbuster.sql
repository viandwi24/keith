CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`client_id` text,
	`label` text NOT NULL,
	`user_agent` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_success_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_person` ON `push_subscriptions` (`person_id`);