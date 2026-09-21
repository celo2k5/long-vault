CREATE TABLE `vaults` (
	`owner` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL
);
