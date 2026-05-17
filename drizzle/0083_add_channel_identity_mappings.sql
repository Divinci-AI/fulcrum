CREATE TABLE `channel_identity_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_type` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_identity_mappings_user_channel_uq` ON `channel_identity_mappings` (`user_id`,`channel_type`);
