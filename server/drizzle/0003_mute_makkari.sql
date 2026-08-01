CREATE TABLE `player_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`preview_timeout_secs` integer DEFAULT 20 NOT NULL,
	`updated_at` integer NOT NULL
);
