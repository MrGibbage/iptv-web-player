CREATE TABLE `channel_codec_cache` (
	`provider_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`video_codec` text NOT NULL,
	`video_passthrough` integer NOT NULL,
	`audio_codec` text,
	`audio_profile` text,
	`audio_passthrough` integer NOT NULL,
	`probed_at` integer NOT NULL,
	PRIMARY KEY(`provider_key`, `channel_id`)
);
