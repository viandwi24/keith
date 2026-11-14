CREATE TABLE `llm_bodies` (
	`call_id` text PRIMARY KEY NOT NULL,
	`request` blob,
	`response` blob,
	`output` blob
);
--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`call_kind` text NOT NULL,
	`trigger` text,
	`turn_id` text,
	`step_index` integer,
	`message_id` text,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`first_chunk_ms` integer,
	`status` text NOT NULL,
	`finish_reason` text,
	`model_id` text NOT NULL,
	`provider` text NOT NULL,
	`upstream_provider` text,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`cache_read` integer,
	`cache_write` integer,
	`reasoning` integer,
	`cost_micro` integer,
	`cost_source` text,
	`fallbacks` text,
	`error_name` text,
	`error_message` text,
	`request_bytes` integer NOT NULL,
	`response_bytes` integer NOT NULL,
	`body_state` text NOT NULL,
	`speaker_id` text,
	CONSTRAINT "llm_calls_call_kind_known" CHECK("llm_calls"."call_kind" IN ('step', 'compaction', 'flush', 'other', 'embedding')),
	CONSTRAINT "llm_calls_trigger_known" CHECK("llm_calls"."trigger" IS NULL OR "llm_calls"."trigger" IN ('send', 'respond', 'regenerate', 'edit', 'wake')),
	CONSTRAINT "llm_calls_status_known" CHECK("llm_calls"."status" IN ('ok', 'error', 'aborted')),
	CONSTRAINT "llm_calls_body_state_known" CHECK("llm_calls"."body_state" IN ('stored', 'truncated', 'purged', 'off')),
	CONSTRAINT "llm_calls_cost_source_known" CHECK("llm_calls"."cost_source" IS NULL OR "llm_calls"."cost_source" IN ('provider', 'estimate')),
	CONSTRAINT "llm_calls_cost_nonneg" CHECK("llm_calls"."cost_micro" IS NULL OR "llm_calls"."cost_micro" >= 0)
);
--> statement-breakpoint
CREATE INDEX `llm_calls_session_started` ON `llm_calls` (`session_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `llm_calls_started` ON `llm_calls` (`started_at`);--> statement-breakpoint
CREATE TABLE `llm_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`person_id` text,
	`room_id` text,
	`app` text NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`cost_micro` integer DEFAULT 0 NOT NULL,
	`primary_model` text,
	`primary_provider` text,
	`bodies_off` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "llm_sessions_kind_known" CHECK("llm_sessions"."kind" IN ('chat', 'task', 'room', 'guest', 'dream', 'aux')),
	CONSTRAINT "llm_sessions_cost_nonneg" CHECK("llm_sessions"."cost_micro" >= 0),
	CONSTRAINT "llm_sessions_calls_nonneg" CHECK("llm_sessions"."calls" >= 0)
);
--> statement-breakpoint
CREATE INDEX `llm_sessions_person_last` ON `llm_sessions` (`person_id`,`last_at`);--> statement-breakpoint
CREATE INDEX `llm_sessions_room_last` ON `llm_sessions` (`room_id`,`last_at`);--> statement-breakpoint
CREATE INDEX `llm_sessions_last` ON `llm_sessions` (`last_at`);