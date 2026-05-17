ALTER TABLE `google_accounts` ADD `owner_user_id` text;--> statement-breakpoint
UPDATE `google_accounts` SET `owner_user_id` = (SELECT `id` FROM `users` ORDER BY `created_at` ASC LIMIT 1) WHERE `owner_user_id` IS NULL;
