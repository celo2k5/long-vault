CREATE TABLE `activity` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`time` integer NOT NULL,
	`event` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);

--> statement-breakpoint
CREATE INDEX `idx_activity_owner_time` ON `activity` (`owner`,`time`);
--> statement-breakpoint
CREATE TABLE `commands` (
	`owner` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`error` text,
	PRIMARY KEY(`owner`, `key`)
);

--> statement-breakpoint
ALTER TABLE `vaults` ADD `last_command` text;