CREATE TABLE `watch_progress` (
	`provider_key` text NOT NULL,
	`media_type` text NOT NULL,
	`media_id` text NOT NULL,
	`position_secs` integer NOT NULL,
	`duration_secs` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider_key`, `media_type`, `media_id`)
);
