CREATE TABLE `executor_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text,
	`version` text,
	`last_seen_at` text,
	`created_at` text NOT NULL
);
