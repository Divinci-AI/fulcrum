CREATE TABLE `slack_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`action` text NOT NULL,
	`reactor_slack_user_id` text NOT NULL,
	`reaction` text NOT NULL,
	`item_ts` text NOT NULL,
	`item_channel` text NOT NULL,
	`item_user` text,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `slack_reactions_item_idx` ON `slack_reactions` (`item_channel`,`item_ts`);--> statement-breakpoint
CREATE INDEX `slack_reactions_reactor_idx` ON `slack_reactions` (`reactor_slack_user_id`);
