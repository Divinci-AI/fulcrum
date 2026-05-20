ALTER TABLE `tasks` ADD `completed_at` text;--> statement-breakpoint
-- Backfill: any task already in a terminal state gets its updated_at copied
-- to completed_at so the Archive view can sort existing rows meaningfully.
-- Active tasks (TO_DO/IN_PROGRESS/IN_REVIEW) stay NULL — they're not done.
UPDATE `tasks` SET `completed_at` = `updated_at` WHERE `status` IN ('DONE', 'CANCELED');--> statement-breakpoint
CREATE INDEX `tasks_completed_at_idx` ON `tasks` (`completed_at`);
