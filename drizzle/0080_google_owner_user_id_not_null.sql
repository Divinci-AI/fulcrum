-- D-6 PR 1b: flip `google_accounts.owner_user_id` to NOT NULL.
--
-- Migration 0078 added the column as nullable and backfilled rows to the
-- tenant's earliest user. After one release of soft rollout, every row
-- should have a non-NULL owner. This migration:
--   1. Re-runs the backfill defensively (no-op when 0078's backfill stuck).
--   2. Recreates the table with the NOT NULL constraint applied to
--      owner_user_id. SQLite doesn't support `ALTER COLUMN SET NOT NULL`,
--      so the standard "create __new, copy, drop, rename" pattern is the
--      only path.
--
-- Rows that *still* have NULL owner_user_id after step 1 (the tenant has
-- zero users — should be impossible after a real sign-in) are filtered
-- out by the INSERT's WHERE clause. They effectively cease to exist; if
-- this ever fires in production it's a sign 0078 was applied to an empty
-- users table.

UPDATE `google_accounts` SET `owner_user_id` = (SELECT `id` FROM `users` ORDER BY `created_at` ASC LIMIT 1) WHERE `owner_user_id` IS NULL;--> statement-breakpoint
CREATE TABLE `__new_google_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`access_token` text,
	`refresh_token` text,
	`token_expiry` integer,
	`scopes` text,
	`calendar_enabled` integer DEFAULT false,
	`gmail_enabled` integer DEFAULT false,
	`sync_interval_minutes` integer DEFAULT 15,
	`last_calendar_sync_at` text,
	`last_calendar_sync_error` text,
	`last_gmail_sync_at` text,
	`last_gmail_sync_error` text,
	`last_gmail_history_id` text,
	`send_as_email` text,
	`needs_reauth` integer DEFAULT false,
	`owner_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_google_accounts` (`id`, `name`, `email`, `access_token`, `refresh_token`, `token_expiry`, `scopes`, `calendar_enabled`, `gmail_enabled`, `sync_interval_minutes`, `last_calendar_sync_at`, `last_calendar_sync_error`, `last_gmail_sync_at`, `last_gmail_sync_error`, `last_gmail_history_id`, `send_as_email`, `needs_reauth`, `owner_user_id`, `created_at`, `updated_at`) SELECT `id`, `name`, `email`, `access_token`, `refresh_token`, `token_expiry`, `scopes`, `calendar_enabled`, `gmail_enabled`, `sync_interval_minutes`, `last_calendar_sync_at`, `last_calendar_sync_error`, `last_gmail_sync_at`, `last_gmail_sync_error`, `last_gmail_history_id`, `send_as_email`, `needs_reauth`, `owner_user_id`, `created_at`, `updated_at` FROM `google_accounts` WHERE `owner_user_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `google_accounts`;--> statement-breakpoint
ALTER TABLE `__new_google_accounts` RENAME TO `google_accounts`;
