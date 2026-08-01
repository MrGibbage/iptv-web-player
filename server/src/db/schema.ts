import { sqliteTable, integer, text, check, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Singleton row: which of the two provider-credential sources this instance
// uses (PLAN.md "Credentials Model"). Deliberately starts unset — "ask
// first" at setup time, same as iptv-scheduler's recorderConfig being a
// real, expected unconfigured first-boot state rather than an error:
//   - 'recorder': this app has no credentials of its own at all. Every
//     provider comes from iptv-recorder's own list, fetched live over HTTP
//     (see ../recorderClient.ts) the same way iptv-scheduler already does
//     for EPG ingestion — avoids a second encrypted copy of credentials
//     iptv-recorder already holds, when the same account is already
//     configured there for DVR.
//   - 'local': this app owns its own encrypted `providers` table (below),
//     for when iptv-recorder isn't in use, or holds a different account
//     than the one being watched here.
// Whichever mode is active, the rest of the app (EPG ingestion, live/VOD/
// series browsing, playback) reads providers through ../providerSource.ts,
// which hides which of the two is actually backing it.
export const providerSourceConfig = sqliteTable("provider_source_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mode: text("mode", { enum: ["recorder", "local"] }),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Singleton row: how this service reaches iptv-recorder, only meaningful
// when providerSourceConfig.mode = 'recorder'. Mirrors iptv-scheduler's own
// recorderConfig table and PLAN.md note exactly — apiKeyEncrypted is as
// sensitive as a provider credential, since it grants access to every
// provider iptv-recorder has configured (see its GET /providers/{id}/
// connection). Deliberately no default connection: an unconfigured row is a
// real, expected state, not an error.
export const recorderConfig = sqliteTable("recorder_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  baseUrl: text("base_url"),
  apiKeyEncrypted: text("api_key_encrypted"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// This app's own IPTV provider accounts, only meaningful when
// providerSourceConfig.mode = 'local'. Same type-discriminated shape as
// iptv-recorder's own providers table (xtream: baseUrl + username/password
// against a player_api.php panel; m3u: a single playlist URL plus an
// optional XMLTV epgUrl, since a playlist carries no programme data of its
// own) — deliberately mirrored rather than referenced, so this table has no
// runtime dependency on iptv-recorder existing. All secret-shaped fields are
// encrypted at rest (see ../crypto.ts) — never selected out as plaintext by
// application code outside that module. No maxConcurrentStreams field here:
// unlike iptv-recorder, this app doesn't actively track/enforce the
// provider's connection limit against anything (PLAN.md decision #5) — a
// rejected connection surfaces the provider's own error as-is.
export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    type: text("type", { enum: ["xtream", "m3u"] })
      .notNull()
      .default("xtream"),
    // Xtream-only — null when type = 'm3u'.
    baseUrl: text("base_url"),
    usernameEncrypted: text("username_encrypted"),
    passwordEncrypted: text("password_encrypted"),
    // M3U-only — null when type = 'xtream'.
    playlistUrlEncrypted: text("playlist_url_encrypted"),
    epgUrlEncrypted: text("epg_url_encrypted"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    typeShapeCheck: check(
      "providers_type_shape",
      sql`
        (${table.type} = 'xtream'
          AND ${table.baseUrl} IS NOT NULL
          AND ${table.usernameEncrypted} IS NOT NULL
          AND ${table.passwordEncrypted} IS NOT NULL
          AND ${table.playlistUrlEncrypted} IS NULL)
        OR
        (${table.type} = 'm3u'
          AND ${table.playlistUrlEncrypted} IS NOT NULL
          AND ${table.baseUrl} IS NULL
          AND ${table.usernameEncrypted} IS NULL
          AND ${table.passwordEncrypted} IS NULL)
      `,
    ),
  }),
);

// Resume/watch-progress tracking (PLAN.md Open Questions — "Dropped:
// resume/watch-progress tracking" in both the VOD and Series sections) —
// the one Laomedeia feature both of those ports explicitly deferred for not
// having a progress store yet. Keyed by providerCacheKey() + mediaType +
// mediaId, same recorder-vs-local namespacing reason as channelCodecCache
// above (VOD streamIds and series episode ids are both provider-scoped
// numbers/strings that mean nothing across a mode switch). mediaType keeps
// 'vod' and 'episode' in separate id spaces under the same provider, since a
// VOD streamId and a series episode id can otherwise collide as strings.
// No title/poster columns — there's no "Continue Watching" rail yet (no
// Home screen built), so this only needs to answer "does this exact
// title/episode have a saved position" for its own detail modal.
export const watchProgress = sqliteTable(
  "watch_progress",
  {
    providerKey: text("provider_key").notNull(),
    mediaType: text("media_type", { enum: ["vod", "episode"] }).notNull(),
    mediaId: text("media_id").notNull(),
    positionSecs: integer("position_secs").notNull(),
    durationSecs: integer("duration_secs"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.providerKey, table.mediaType, table.mediaId] }),
  }),
);

// Caches each channel's codec passthrough decision (PLAN.md "Playback
// architecture") so repeat tunes skip re-probing with ffprobe. Keyed by
// providerSource.providerCacheKey() + channelId — same namespacing reason as
// the EPG cache: recorder ids and local ids are different, unrelated
// numeric spaces, so the mode has to be part of the key or switching modes
// could misread one provider's cached codec as another's. Probed once and
// cached indefinitely — a provider changing a channel's encoding without
// this cache ever being invalidated is a known, accepted simplification for
// now (see PLAN.md Open Questions).
//
// Video and audio are judged independently — found via real testing against
// the sonix account that this has to work this way: a channel can need
// video passthrough + audio transcode at the same time (a real ABC NEWS
// stream sent AAC in the "Main" profile — mp4a.40.1 — which decodes fine
// into the MPEG-TS container with zero bitstream translation, so it looked
// fine at the file level, but browsers' MSE only decode AAC-LC/HE-AAC, not
// Main/SSR, so hls.js hit a hard bufferAddCodecError trying to play it).
// TS-container compatibility (recorder's lesson) and browser-decoder
// compatibility (this table) are two different questions.
export const channelCodecCache = sqliteTable(
  "channel_codec_cache",
  {
    providerKey: text("provider_key").notNull(),
    channelId: text("channel_id").notNull(),
    videoCodec: text("video_codec").notNull(),
    videoPassthrough: integer("video_passthrough", { mode: "boolean" }).notNull(),
    audioCodec: text("audio_codec"),
    // ffprobe's stream profile string (e.g. "LC", "Main", "HE-AAC") — null
    // when there's no audio stream at all or profile info is unavailable.
    audioProfile: text("audio_profile"),
    audioPassthrough: integer("audio_passthrough", { mode: "boolean" }).notNull(),
    probedAt: integer("probed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.providerKey, table.channelId] }),
  }),
);
