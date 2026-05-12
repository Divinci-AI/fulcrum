CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_name_unique` ON `teams` (`name`);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_team_user_unique` ON `team_members` (`team_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `acls` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_at` text NOT NULL,
	`granted_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acls_resource_principal_unique` ON `acls` (`resource_type`,`resource_id`,`principal_type`,`principal_id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `visibility` text DEFAULT 'tenant' NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` ADD `visibility` text DEFAULT 'tenant' NOT NULL;
