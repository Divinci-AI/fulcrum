ALTER TABLE `google_accounts` ADD `drive_enabled` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `google_accounts` ADD `last_drive_sync_at` text;
