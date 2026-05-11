CREATE TABLE `mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mentions_source_user_unique` ON `mentions` (`source_type`,`source_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `mentions_user_idx` ON `mentions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `mentions_source_idx` ON `mentions` (`source_type`,`source_id`);
