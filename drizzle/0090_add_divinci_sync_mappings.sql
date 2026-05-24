CREATE TABLE `divinci_sync_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`divinci_file_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`last_synced_at` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `divinci_sync_entity_idx` ON `divinci_sync_mappings` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `divinci_sync_collection_idx` ON `divinci_sync_mappings` (`collection_id`);
