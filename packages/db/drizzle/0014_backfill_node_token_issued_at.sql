-- Custom SQL migration file, put your code below! --
UPDATE `nodes` SET `token_issued_at` = `created_at` WHERE `token_issued_at` IS NULL;
