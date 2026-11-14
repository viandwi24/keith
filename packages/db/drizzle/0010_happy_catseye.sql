CREATE TABLE `plugin_kv` (
	`plugin` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin`, `key`)
);
