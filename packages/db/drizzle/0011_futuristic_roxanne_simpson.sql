CREATE TABLE `owner_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`requester` text NOT NULL,
	`plugin` text NOT NULL,
	`operation` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`outcome` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text
);
--> statement-breakpoint
CREATE INDEX `owner_reviews_status` ON `owner_reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `owner_reviews_requester` ON `owner_reviews` (`requester`,`status`);