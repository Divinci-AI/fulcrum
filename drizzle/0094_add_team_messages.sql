CREATE TABLE `team_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `team_messages_created_at_idx` ON `team_messages` (`created_at`);
