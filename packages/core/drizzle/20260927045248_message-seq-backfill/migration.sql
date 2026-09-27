-- Custom SQL migration file, put your code below! --
-- P3-H3 (D3): number existing messages 1, 2, ... per thread in their old order, (created_at, id).
UPDATE `messages` SET `seq` = `ranked`.`seq`
FROM (
	SELECT `id`, row_number() OVER (PARTITION BY `thread_id` ORDER BY `created_at`, `id`) AS `seq`
	FROM `messages`
) AS `ranked`
WHERE `messages`.`id` = `ranked`.`id`;
