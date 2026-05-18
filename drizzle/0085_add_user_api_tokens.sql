CREATE TABLE `user_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_api_tokens_token_hash_uq` ON `user_api_tokens` (`token_hash`);
