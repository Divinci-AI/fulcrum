CREATE TABLE `notification_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`toast_enabled` integer,
	`desktop_enabled` integer,
	`sound_enabled` integer,
	`pushover_enabled` integer,
	`pushover_user_key_fnox` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
