ALTER TABLE `users` ADD `is_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `users` SET `is_admin` = 1 WHERE `id` = (SELECT `id` FROM `users` ORDER BY `created_at` ASC LIMIT 1);
