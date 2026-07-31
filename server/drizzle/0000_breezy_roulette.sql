CREATE TABLE `provider_source_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mode` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'xtream' NOT NULL,
	`base_url` text,
	`username_encrypted` text,
	`password_encrypted` text,
	`playlist_url_encrypted` text,
	`epg_url_encrypted` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "providers_type_shape" CHECK(
        ("providers"."type" = 'xtream'
          AND "providers"."base_url" IS NOT NULL
          AND "providers"."username_encrypted" IS NOT NULL
          AND "providers"."password_encrypted" IS NOT NULL
          AND "providers"."playlist_url_encrypted" IS NULL)
        OR
        ("providers"."type" = 'm3u'
          AND "providers"."playlist_url_encrypted" IS NOT NULL
          AND "providers"."base_url" IS NULL
          AND "providers"."username_encrypted" IS NULL
          AND "providers"."password_encrypted" IS NULL)
      )
);
--> statement-breakpoint
CREATE TABLE `recorder_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`base_url` text,
	`api_key_encrypted` text,
	`updated_at` integer NOT NULL
);
