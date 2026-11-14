CREATE TABLE `succession_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`run_id` text,
	`heir` text,
	`started_at` integer,
	`grace_started_at` integer,
	`claimable_at` integer,
	`last_sign_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "succession_state_single" CHECK("succession_state"."id" = 1),
	CONSTRAINT "succession_state_known" CHECK("succession_state"."state" IN ('idle', 'check-in', 'grace', 'claimable', 'claimed'))
);
