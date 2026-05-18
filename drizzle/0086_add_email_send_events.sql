CREATE TABLE `email_send_events` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_email` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`raw_payload` text,
	`provider_message_id` text,
	`user_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_send_events_recipient_idx` ON `email_send_events` (`recipient_email`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `email_send_events_user_idx` ON `email_send_events` (`user_id`,`occurred_at`);
