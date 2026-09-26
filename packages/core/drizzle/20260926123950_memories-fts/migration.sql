-- Custom SQL migration file, put your code below! ---- memories_fts: FTS5 index over memories.content (docs/architecture/memory.md#recall).
-- It keeps its own copy of the text keyed by the memory id (not an external-content table), because
-- `memories` has a text primary key and VACUUM may renumber its implicit rowids.
CREATE VIRTUAL TABLE `memories_fts` USING fts5(
	`id` UNINDEXED,
	`content`,
	tokenize = 'porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `memories_fts` (`id`, `content`) SELECT `id`, `content` FROM `memories`;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_insert` AFTER INSERT ON `memories` BEGIN
	INSERT INTO `memories_fts` (`id`, `content`) VALUES (new.`id`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_delete` AFTER DELETE ON `memories` BEGIN
	DELETE FROM `memories_fts` WHERE `id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_update` AFTER UPDATE OF `id`, `content` ON `memories` BEGIN
	DELETE FROM `memories_fts` WHERE `id` = old.`id`;
	INSERT INTO `memories_fts` (`id`, `content`) VALUES (new.`id`, new.`content`);
END;
