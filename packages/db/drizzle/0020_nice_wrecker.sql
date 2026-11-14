CREATE TABLE `person_style` (
	`person_id` text PRIMARY KEY NOT NULL,
	`address` text,
	`language` text DEFAULT 'auto' NOT NULL,
	`brevity` text DEFAULT 'normal' NOT NULL,
	`formality` text DEFAULT 'neutral' NOT NULL,
	`gentle_topics` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "person_style_language_known" CHECK("person_style"."language" IN ('auto', 'en-US', 'id-ID', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'nl-NL', 'ja-JP', 'ko-KR', 'zh-CN', 'ar', 'hi-IN')),
	CONSTRAINT "person_style_brevity_known" CHECK("person_style"."brevity" IN ('short', 'normal', 'full')),
	CONSTRAINT "person_style_formality_known" CHECK("person_style"."formality" IN ('casual', 'neutral', 'formal')),
	CONSTRAINT "person_style_address_length" CHECK("person_style"."address" IS NULL OR (length("person_style"."address") BETWEEN 1 AND 40))
);
--> statement-breakpoint
CREATE TABLE `persona` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`template_id` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "persona_singleton" CHECK("persona"."id" = 'keith'),
	CONSTRAINT "persona_template_known" CHECK("persona"."template_id" IN ('butler', 'friend', 'professional', 'custom'))
);
--> statement-breakpoint
CREATE TABLE `persona_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`template_id` text NOT NULL,
	`body` text NOT NULL,
	`reason` text NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	`note` text,
	CONSTRAINT "persona_versions_template_known" CHECK("persona_versions"."template_id" IN ('butler', 'friend', 'professional', 'custom')),
	CONSTRAINT "persona_versions_reason_known" CHECK("persona_versions"."reason" IN ('template', 'edit', 'restore'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `persona_versions_version` ON `persona_versions` (`version`);