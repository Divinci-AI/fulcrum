CREATE TABLE `github_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`label` text NOT NULL,
	`pat_fnox_key` text NOT NULL,
	`github_login` text,
	`github_avatar_url` text,
	`last_validated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_accounts_owner_label_uq` ON `github_accounts` (`owner_user_id`,`label`);
