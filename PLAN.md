# Plan

## Status

Decisions below resolved on 2026-07-31; scaffolding built same day (pnpm workspace,
Fastify + Drizzle + SQLite server, Vite + React web — see "Scaffolding" section).
Living document, same role PLAN.md plays in iptv-recorder and iptv-scheduler.

## What this is

A web-based IPTV player for Xtream-compatible providers: Live TV, a fast searchable EPG,
and Movies/Series browsing with resume — most of what Laomedeia (the Windows desktop
client at `~/projects/iptv` on ganymede) already does, reachable from a browser instead
of installed per-machine.

This is a **sibling service to iptv-recorder and iptv-scheduler, not an extension of
either.** Those two already established the pattern this project follows: separate
service, own database, own secrets, a thin HTTP client to the other service only for the
specific thing it needs (see iptv-scheduler's `recorderClient.ts`, and its `crypto.ts`
header comment noting it deliberately mirrors iptv-recorder's own file with a separate
key — "two independent services"). VOD/Series/Live browsing has no home in a
rules/scheduling service, so this gets its own project rather than bolting onto either.

## What Laomedeia gives us for free (porting candidates)

- `electron/xtream.ts` — Xtream API client (account validation, Live/VOD/Series calls,
  stream URL builders). Plain HTTP/JSON, framework-agnostic already.
- `electron/epg.ts`, `epg-db.ts`, `xmltv.ts` — streaming XMLTV parse into
  better-sqlite3 + FTS5, atomic staging-table swap so a refresh never exposes a partial
  guide. Purpose-built for exactly the guide-rendering/search workload this needs.
- React UI patterns — `EpgGrid` (tanstack-virtual), `ChannelList`, `VodBrowser`,
  `SeriesBrowser`, `HomeScreen`, the CSS-token theme system. Same virtualization/search/
  browse shape works in a plain browser tab.
- Data model shape — favorites, hidden channels, progress, category prefs map directly
  onto DB rows instead of JSON files.

## Decisions (made 2026-07-31)

### 1. Playback architecture: hybrid

Passthrough remux (no re-encode) when the source codec is already browser-legal;
transcode fallback otherwise. Most efficient at scale, most complex to build — needs
codec probing plus two serving paths.

Laomedeia plays raw Xtream `.ts` URLs directly into libmpv, backed by a hand-built
event-driven watchdog (stall detection, GPU-decode wedge detection, software-decode
fallback) built after real production incidents. None of that exists in a browser, and
browsers can't play raw MPEG-TS directly, so this needs its own serving layer regardless
of which of the three original options got picked.

iptv-recorder's `server/src/worker/ffmpegRemux.ts` already proved against a real channel
that `-c copy -f mpegts` is required for the copy path — fragmented MP4 broke on
ADTS-framed AAC and MP2/AC-3 audio (see that file's header comment). That lesson
transfers directly to the passthrough side of the hybrid. The *code* doesn't: recorder's
remux is a fixed-duration capture-to-file for one job; this needs a continuous process
serving possibly multiple simultaneous viewers, a different lifecycle entirely, plus new
work to decide the transcode-fallback trigger (codec probe against a known browser-legal
allowlist) and to actually implement the transcode path. New code, informed by an
already-paid-for lesson on the passthrough half only.

**Implemented 2026-07-31 — see "Playback implementation" below for the final design
(HLS with TS segments, video/audio judged independently, one process per session) and the
two real bugs found building it against the actual `sonix` account.**

### 2. Relationship to iptv-recorder / iptv-scheduler: sibling, optional credential dependency

New sibling service, own database. Revised from the original "no runtime dependency on
recorder" stance: provider credentials now follow iptv-scheduler's own pattern instead —
an "ask first" setup screen (`ProviderSourceConfig.mode`, see "Provider-credential store"
below) lets this app either source providers from iptv-recorder live over HTTP (no local
copy of those credentials at all, avoiding a second encrypted copy of an account
iptv-recorder already holds for DVR) or own a local encrypted store when recorder isn't
in use or holds a different account. Whichever is chosen, the rest of the app reads
providers through `server/src/providerSource.ts`, which hides which of the two is active.

~~iptv-recorder's completed-recordings library is not surfaced in v1.~~ Built 2026-08-01,
see "Recording support" below — the core Live/EPG/VOD/Series viewer was solid enough by
then to build on.

### 3. EPG ingestion: independent, ported from Laomedeia

iptv-scheduler already ingests EPG data (`server/src/epg/*`), but its `epg_programs`
table is shaped for rule-matching (flat table, no FTS5, no time/channel-bounded
virtualization queries) — not for rendering a fast searchable guide grid. This service
ports Laomedeia's own EPG module (`epg.ts`/`epg-db.ts`/`xmltv.ts`) wholesale rather than
force scheduler's differently-shaped table into a guide-rendering role it wasn't built
for, accepting a third independent XMLTV download from the provider (Laomedeia desktop,
scheduler, this) in exchange for no cross-service runtime dependency and no reshaping
work. Revisit only if the provider's feed size/refresh cost turns out to make that
wasteful — not measured yet.

### 4. Credentials & multi-user model: single-user, no auth

Matches Laomedeia's own model (explicit non-goal: multi-profile). No login system, no
per-user state separation. LAN-only fits this by default (see #6).

### 5. Concurrent viewers vs. provider connection limits: surface provider errors only

No active tracking/enforcement of the provider's `max_connections` against current
stream count for v1. If the provider itself rejects a connection over its limit, that
error surfaces to the user as-is. Revisit if this proves confusing in practice.

### 6. Deployment & remote access: LAN-only for v1

docker-server is the natural home — matches the existing m3u-editor-stack and the
documented Hetzner/FRP pattern for `m3u.pelorus.org`. Ship the core viewing experience
over the LAN (via OPNsense Caddy) first; add remote access later via the same Hetzner
Caddy + FRP precedent (deliberately bypassing Cloudflare's CDN/Tunnel for video traffic)
once the core product is solid.

### 7. VOD/Series container formats

Xtream VOD/Series entries carry whatever `container_extension` the provider used — mp4
plays natively in `<video>`, mkv and others don't. The hybrid playback approach from #1
covers VOD/Series the same way it covers Live — same codec-probe/passthrough-or-transcode
logic, not a separate system.

## Stack: confirmed, matches iptv-recorder/iptv-scheduler

Fastify + Drizzle + better-sqlite3 server-side, Vite + React (TypeScript) web-side, pnpm
workspace with `server/` and `web/` packages. Same convention as both sibling projects —
consistent tooling across all three, less context-switching.

## Scaffolding (2026-07-31)

Initial pnpm workspace scaffolded directly off iptv-scheduler's own scaffold commit
(`43bcd3c`) as a template — root `package.json`/`pnpm-workspace.yaml`/`tsconfig.base.json`,
`server/` (Fastify health check on port 4300 — 3000/4000-range already used by
iptv-recorder/iptv-scheduler, Drizzle client pointed at a placeholder `schema.ts`,
`drizzle.config.ts`), `web/` (Vite + React, dev-server proxy to `/api`, a health-check
ping in `App.tsx`). No routes, no DB tables, no crypto/credential storage yet — those
land with the first real feature, same as both sibling projects did.

Verified booting end-to-end: `pnpm install` clean, server's `/health` and `/health/db`
both return `{"status":"ok"}`, the Vite dev server's `/api` proxy reaches the Fastify
backend (`curl localhost:5173/api/health` → `ok`), and both packages typecheck
(`tsc --noEmit` / `tsc -b`) with zero errors.

## Provider-credential store (2026-07-31)

First real feature. Supports **both Xtream Codes and M3U** providers (not Xtream-only —
revised from the original porting-candidates framing, which followed Laomedeia's
Xtream-only model; this app follows iptv-recorder/iptv-scheduler's broader support
instead). Built as an "ask first" choice, mirroring iptv-scheduler's own relationship to
iptv-recorder rather than always owning credentials locally:

- `provider_source_config` (singleton, starts unset): `mode` is `'recorder' | 'local' |
  null`. Unset is a real, expected first-boot state — the web UI shows a choice screen
  ("Use iptv-recorder's credentials" vs. "Enter my own provider details") before anything
  else renders, the same way iptv-scheduler's UI gates everything behind a working
  recorder connection.
- **`mode = 'recorder'`**: `recorder_config` (singleton: baseUrl + encrypted API key) and
  `server/src/recorderClient.ts` — both mirror iptv-scheduler's own recorderConfig/
  recorderClient.ts almost exactly (thin HTTP client, `RecorderNotConfiguredError`,
  test-before-save on `PUT /config/recorder`). Trimmed to the two endpoints this app
  needs (`GET /providers`, `GET /providers/{id}/connection`) — no recordings-related
  methods, since this app doesn't touch recordings (decision #2 above).
- **`mode = 'local'`**: `providers` table, own encrypted store, structurally identical to
  iptv-recorder's own (type-discriminated `xtream | m3u`, a CHECK constraint enforcing
  the right fields per type, AES-256-GCM at rest via `crypto.ts` — deliberately mirrored,
  not shared, with its own `ENCRYPTION_KEY`, same "independent secrets store" precedent as
  iptv-scheduler vs. iptv-recorder). Full CRUD (`POST/GET/PUT/DELETE /providers`) plus
  `POST /providers/test` (live auth check before saving — `player_api.php` auth for
  Xtream, `#EXTM3U` fetch check for M3U), ported from iptv-recorder's own
  `worker/xtreamAuth.ts`. No `maxConcurrentStreams` field — this app doesn't track
  connection limits (decision #5).
- `server/src/providerSource.ts` — the mode-aware accessor every future feature (EPG
  ingestion, live/VOD/series browsing, playback) should read providers through, so the
  recorder-vs-local choice stays contained to one module instead of every downstream
  feature needing its own branch on `providerSourceConfig.mode`. First consumer: EPG
  ingestion (below), via `providerCacheKey()`.
- Web UI: `ProviderSourceChoice` (the ask-first screen) → `RecorderConnection` (connect
  form, then a read-only list of iptv-recorder's providers) or `LocalProviders` (add/test/
  list/delete, Xtream/M3U type selector with conditional fields). A "Change source" button
  returns to the choice screen without touching the persisted mode until a new choice is
  actually made — there's no "unset" state to bounce through in between.

Verified end-to-end with a real browser (Playwright): ask-first screen renders first on a
clean DB; choosing local mode reaches the provider form; Xtream and M3U creation both
work with credentials never round-tripped back in any response; `POST /providers/test`
correctly reports failure against an unreachable host; delete works; "Change source"
returns to the choice screen and choosing recorder mode reaches the connect form. Both
packages typecheck and lint clean.

## EPG ingestion (2026-07-31)

Ported wholesale from Laomedeia (`electron/epg.ts`, `epg-db.ts`, `xmltv.ts`) per decision
#3 above — same staging-swap/FTS5 design, proven at guide-rendering scale (thousands of
channels, 100k+ programs), same Xtream-derives-its-own-URL (`{baseUrl}/xmltv.php?
username=...&password=...`) / M3U-needs-a-manual-`epgUrl` split. Two real changes from
the original, both consequences of this being a multi-provider REST service instead of a
single-account Electron app:

- **Per-provider, not per-instance.** Laomedeia only ever had one active provider, so its
  state (refresh-in-progress, last error) and its SQLite cache file were both module-level
  singletons. This app can have several configured providers at once (recorder mode
  returns iptv-recorder's whole list), so `server/src/epg/epg.ts` keys refresh state by a
  `providerKey` string in a `Map`, and `epgDb.ts` opens a separate cache file per key
  (`epg-cache-<key>.sqlite3`). The key comes from `providerSource.ts`'s new
  `providerCacheKey(id)` — `recorder-3` vs. `local-3` — so switching source mode can never
  let one provider's cache be misread as another's even if the two id spaces collide
  numerically (they're unrelated: iptv-recorder's ids vs. this app's own local table).
- **No push channel.** Laomedeia's `epg.ts` had an `onStatusChange` callback wired to
  Electron IPC so the renderer got live refresh-progress updates. This is a stateless REST
  API with nothing like that yet — `GET /providers/:id/epg/status` is poll-only for now.

Scheduler (`server/src/epg/index.ts`) mirrors Laomedeia's own `main.ts` startup-refresh +
hourly `setInterval` exactly, generalized to loop over every enabled provider from
`listEffectiveProviders()` instead of one hardcoded "active" provider — one provider's
failure (unreachable, no EPG URL) is caught and logged without aborting the rest of the
loop. `refresh()` itself still no-ops under a 12h TTL unless `force: true`, unchanged from
the original.

Routes, all nested under `/providers/:id/epg/*` since a guide is always scoped to one
provider: `GET status`, `POST refresh` (body `{force?}`), `GET programs` (channelIds +
time range), `GET search` (FTS, "still airing or later" only — already-ended programs are
excluded by design, not a bug), `GET bounds`. Status/programs/search/bounds are pure local
SQLite reads and never touch the network — only `POST refresh` needs a live connection, so
guide reads stay available even if the provider itself is temporarily unreachable.

Verified end-to-end against a synthetic XMLTV file (via the ported `IPTV_EPG_FILE` dev
override, same as Laomedeia's): ingest correctly parses channels/programs and stages them
atomically (`channelCount`/`programCount` correct after refresh); `programs` returns all
rows in a time range regardless of past/future; `search` correctly excludes an
already-ended program and correctly returns a currently-airing one; refresh without
`force` no-ops under the TTL (`lastRefreshMs` unchanged); a provider with no `epgUrl`
configured fails cleanly with a status-level error rather than throwing; an unknown
provider id 400s. Cache-file namespacing confirmed on disk (`epg-cache-local-1.sqlite3`,
`epg-cache-local-2.sqlite3` — no collision). Typechecks clean.

## Live TV channel browsing (2026-07-31)

Category filter + channel list, unified across Xtream and M3U — discovery only, no
playback yet (decision #1 is still unresolved, and this feature is a real prerequisite
for it: playback needs an actual channel to tune).

- `server/src/worker/xtreamLive.ts` — Live-only subset of Laomedeia's `electron/xtream.ts`
  (`get_live_categories`/`get_live_streams`). Account validation and VOD/Series were
  already covered elsewhere or are separate future features, not ported here.
- `server/src/worker/m3uPlaylist.ts` — ported from iptv-scheduler's own
  `server/src/epg/m3u.ts` almost unchanged. M3U has no category endpoint the way Xtream
  does — `group-title` *is* the category name directly, so a channel's `channelId` is its
  resolved stream URL (no synthetic id exists to use instead), same convention
  iptv-recorder/iptv-scheduler already settled on for M3U.
- `server/src/liveChannels.ts` — the unifying layer (`listLiveCategories`/
  `listLiveChannels`), branching on `ProviderConnection.type` so routes and the web UI
  never need to know which provider type they're looking at. For M3U, category listing
  re-parses the whole playlist to derive distinct `group-title` values (no caching yet —
  worth revisiting if playlists prove large enough to make repeated browsing feel slow).
- New route: `GET /effective-providers` (in `routes/providers.ts`) — the first consumer
  of `providerSource.listEffectiveProviders()` from *outside* that module. Every future
  browsing feature (VOD, Series, Guide) should fetch its provider picker from here, not
  from the mode-specific `/providers` or `/config/recorder/providers` endpoints, so the
  UI never needs its own branch on provider-source mode either.
- Routes: `GET /providers/:id/live/categories`, `GET /providers/:id/live/channels`
  (optional `categoryId` query param).
- Web UI: `LiveChannels.tsx` — provider picker (only shown when more than one provider),
  category dropdown, channel list with logos. `App.tsx` gained its first real navigation:
  a plain `useState` tab switch between Providers/Live TV, not react-router-dom yet — only
  two real areas exist so far; worth switching once there are enough pages to justify it
  (Guide/VOD/Series), the same threshold iptv-scheduler crossed before adopting it.

**Verified against the real `sonix` Xtream account** (not a synthetic fixture) via
iptv-recorder in recorder mode: 24+ real categories, a 58-channel News category with real
names/logos (Yahoo Finance, ABC News, Al Jazeera, BBC World News, C-SPAN, CNBC, ...), and
the full cross-reference proven end-to-end — ABC News's `epgChannelId` (45438) correctly
resolves to real, currently-airing program data ("ABC News Live") from the EPG ingestion
built in the previous session.

**Real bug found and fixed via browser testing**, not just typecheck/lint: switching the
category dropdown while the (much larger, slower) unfiltered "all categories" request was
still in flight let that stale response land *after* the fast filtered one and silently
overwrite it — the dropdown would show "US| NEWS NETWORK" selected while the list
underneath actually rendered the full 4,518-channel unfiltered set. Confirmed by directly
timing both requests (unfiltered: 649ms for 4,518 channels; filtered: near-instant for 58)
before fixing. Fixed with a standard stale-closure guard (a `current` flag set false in
the effect's cleanup) in both the categories and channels fetch effects in
`LiveChannels.tsx`. Re-verified via the same browser test — correct 58-channel list now
renders every time.

## EPG Guide grid (2026-07-31)

Ported from Laomedeia (`src/components/EpgGrid.tsx` + `epg.css`) — same virtualized
channel-by-time grid (`@tanstack/react-virtual`, row-only virtualization; the time axis is
plain absolute positioning inside a wide scrollable container, not virtualized), same
staging-swap-backed data underneath it. This is the single largest UI port so far and the
first real proof that the whole stack (credentials → EPG ingestion → Live channels →
guide rendering) fits together.

Two real changes from the original:

- **Electron IPC → REST, and no push channel.** `window.epg.*` calls become plain
  `api.get`/`api.post` calls against `/providers/:id/epg/*`. Laomedeia got live
  refresh-progress updates over IPC (`onStatusChange`); this app polls `GET .../status`
  every 30s instead (reusing the same timer as the now-line tick), catching the hourly
  background scheduler's refreshes without a page reload. A manual "Refresh" click doesn't
  need polling at all — `POST .../refresh` already blocks until the ingest finishes and
  returns the final status directly. This resolves Open Question #3 from the previous
  session (poll-only was flagged as a real gap "once the guide UI actually needs to show
  progress" — it does now, and polling turned out to be sufficient).
- **No tune/record UI.** Laomedeia's version has "▶ Watch"/"⏺ Record" actions on the
  selected-program detail panel and highlights the currently-tuned channel's row. Neither
  exists here — playback (decision #1) is still unresolved and recordings are an explicit
  non-v1 (decision #2) — so the detail panel is info-only (title, channel, time,
  description), and channel cells have no click behavior.

Also standalone rather than prop-driven: Laomedeia's `App.tsx` lifts Live TV's channel
list/category selection so Guide and Live TV share one selection; there's no shared
app-level state yet (only two other pages exist), so `EpgGuide.tsx` fetches its own
provider/category/channel list independently — same pattern as `LiveChannels.tsx`,
including the same stale-response guard on the channels fetch (applied from the start
this time, having already found that exact race once).

CSS required adding a handful of extra design tokens (`--bg-0` through `--bg-3`,
`--text-dim`, `--text-faint`, `--border-strong`, `--accent-soft`, `--now-line`,
`--radius-sm`) to `index.css` — Laomedeia's own theme system has 16 semantic tokens per
palette; these are a minimal derived subset mapped onto this app's existing simpler
palette, not a port of the full multi-theme system (still just System/light/dark via
`prefers-color-scheme`, not the 8 named themes).

**Verified against the real, already-ingested `sonix` guide** (1,974 channels, 103,056
programs) via a real browser: grid renders scrolled to the current time with the now-line
visible, real program titles/times for real channels; switching to the News category
correctly narrows to the same 58 real channels (Yahoo Finance, ABC News, Al Jazeera, BBC
World News, Bloomberg, C-SPAN, ...) with logos; clicking a program populates the detail
panel with real title/time/description, past programs dimmed, selected program
highlighted; full-text search returns real results across channels/titles/descriptions
with correct LIVE badges on currently-airing programs. No console errors. Both packages
typecheck and lint clean.

## Playback implementation (2026-07-31)

Resolves decision #1. The design proposed before building matched what got built, with
one real correction found only through testing against a real provider (below).

- **Always HLS with MPEG-TS segments**, never fragmented MP4 — this is what lets
  recorder's `-c copy -f mpegts` lesson keep applying regardless of source audio codec
  (ADTS AAC, MP2, AC-3 all pass through a TS segment with zero bitstream translation; fMP4
  would hit the exact wall recorder already found and fixed).
- **`server/src/playback/codecProbe.ts`** — `ffprobe`s a channel's video and audio streams
  once, caches the decision in the new `channel_codec_cache` table (keyed by
  `providerSource.providerCacheKey()` + channelId, same namespacing reason as the EPG
  cache). Video: passthrough only for `h264`, matching the conservative allowlist already
  planned.
- **`server/src/playback/hlsSession.ts`** — one ffmpeg process per playback session (not
  shared across viewers, per the original plan), sliding-window live HLS
  (`-hls_flags delete_segments`, no retention), `-hls_time 4 -hls_list_size 6`. No
  auto-restart on ffmpeg failure — mirrors Laomedeia's own explicit decision (SDD: "an
  automatic kill-and-relaunch was tried and abandoned... landed instead: a fixed, honest
  message with no Retry") — a failed session surfaces its error via
  `GET /stream/:id/status`; the user retries by starting a new one.
- **Routes** (`routes/playback.ts`): `POST /providers/:id/live/stream` (body
  `{channelId}`, blocks until the stream actually starts or fails — no client-side retry
  needed for the first load), `GET /stream/:sessionId/:filename` (playlist/segments),
  `GET /stream/:sessionId/status`, `DELETE /stream/:sessionId`.
- **Web UI**: `Player.tsx` (`hls.js`, since only Safari has native HLS), wired into both
  `LiveChannels.tsx` ("Watch" per row) and `EpgGuide.tsx`'s detail panel ("▶ Watch",
  requiring a reverse lookup from the selected program's EPG channel id back to the live
  channel — same idea as Laomedeia's own `streamsByEpgId`).

### Real bug #1 — the audio-profile allowlist was wrong, found only by actually watching

The original plan judged audio passthrough by `ffprobe`'s `profile` string (AAC-LC/HE-AAC
"safe", Main/SSR "not"), on the theory that TS-container compatibility (recorder's lesson)
and MSE decoder compatibility were the same question for audio the way they're clearly
different for video. They aren't. A real `sonix` channel (ABC NEWS) reported
`profile: "HE-AAC"` from ffprobe's own deeper stream analysis (it detected an SBR
extension) — but the *raw ADTS header's base object type*, which is what hls.js's
demuxer actually reads to build the browser-facing `mp4a.40.*` codec string, still
signaled Main (`mp4a.40.1`), which every browser's MSE rejects outright
(`bufferAddCodecError`). HE-AAC is commonly a Main/LC base layer plus an SBR extension;
ffprobe's semantic label doesn't reliably reflect what a straight copy leaves in the ADTS
header. Fix: dropped the audio allowlist entirely — audio is now **always** transcoded to
AAC-LC when a channel has an audio stream at all (cheap, unlike video, so there's no real
cost to just not chasing this class of edge case). Video's `h264`-only allowlist is
unaffected — `codec_name` alone is unambiguous for video in a way AAC profile strings
turned out not to be for audio.

### Real bug #2 — a graceful-shutdown race looked like an orphaned process, but wasn't

Testing the `tsx watch`-restart orphan-prevention (added specifically because this
project already hit a real orphaned-process incident earlier, with plain tsx watch
supervisors, no ffmpeg involved) initially looked like it had failed: touching a file to
trigger a restart left the ffmpeg process alive for several seconds afterward. Confirmed
with an explicit log line in the `SIGTERM`/`SIGINT` handler that the handler *does* fire
immediately — the delay was ffmpeg's own HLS muxer taking anywhere from ~1–5s to flush and
exit gracefully after receiving `SIGTERM`, not a failure to signal it at all. The
already-planned `SIGKILL`-after-`KILL_GRACE_MS` (3s) fallback in `stopSession()` bounds
this regardless. No code change needed — this was a case of the safety mechanism working
correctly but the first observation catching it mid-shutdown rather than genuinely
orphaned.

**Verified end-to-end against the real `sonix` account**: a live HLS session for a real
channel (ABC NEWS, then Yahoo Finance) actually played in a real browser — confirmed via
`video.readyState === 4` (`HAVE_ENOUGH_DATA`), advancing `currentTime`, real `1920×1080`
dimensions, and a screenshot showing an actual live broadcast frame (a real Yahoo Finance
segment with a live stock ticker). Verified clean teardown on both the happy path
(`DELETE`, confirmed no orphaned process/directory) and the `tsx watch`-restart path
(confirmed via explicit shutdown-handler logging). Both packages typecheck and lint clean.

## Playback logging (2026-08-01)

Prompted by a real incident: a channel (Animal Planet) stopped mid-watch and there was no
way to tell whether the provider dropped it or something on this end failed. Investigating
turned up two compounding gaps, both now fixed:

- **No persistent log file at all** — every diagnostic (`console.log`) only ever went to
  the process's own stdout, wherever that happened to be redirected. In dev, that redirect
  had pointed at a scratchpad file that got deleted mid-session, silently losing everything
  logged since — confirmed by checking `/proc/<pid>/fd/1`, which pointed at
  `(deleted)`. `console.log` alone is not durable logging.
- **Even the in-memory detail was ephemeral** — `hlsSession.ts` already captured ffmpeg's
  stderr into a rolling tail, but only used it for the *startup*-failure error message;
  an unexpected exit *after* a session was already running set a generic
  `"ffmpeg exited unexpectedly (code X)"` with no stderr attached, and the whole session
  (including that stderr) is deleted from memory within 30–40s by the idle sweep regardless.

Fixed with `server/src/logger.ts` — a small shared `log(scope, message)` that always
appends to a real file (`data/logs/app.log`, one rotation generation at 2MB, mirroring the
spirit of Laomedeia's own `logger.ts` without needing its fuller 4-generation scheme for
what's currently a single log) independent of how the process itself was started. Wired in
throughout: `hlsSession.ts` now logs session start (provider/channel/codec decision),
successful start, every stop with its reason (`stopped by client` / `idle timeout` /
`server shutting down` / `startup failed` / `startup timed out`), and — the actual fix for
the original incident — an unexpected mid-stream exit now logs the exit code **and the
full captured stderr tail**, permanently. `codecProbe.ts` logs every new probe decision.
The EPG module's existing ad-hoc `console.log` calls and the shutdown handler were moved
onto the same shared logger for consistency.

Also added: `Player.tsx` now polls `GET /stream/:id/status` every 5s while playing, so a
server-side failure surfaces its real reason immediately in the UI instead of waiting for
hls.js to notice indirectly through failed segment fetches and report a generic
client-side error with no idea why the server actually stopped.

**Verified by deliberately simulating a mid-stream crash** (`kill -9` on the ffmpeg
process directly, bypassing the app's own stop path) against a real channel: confirmed the
in-memory `GET /stream/:id/status` immediately reflected the error, confirmed the full
ffmpeg startup log (codecs, stream mapping, segment writes) was captured in
`data/logs/app.log`, and confirmed that record survived past the point where the idle
sweep removed the session from memory entirely (`idle timeout` logged ~30s later, session
gone from the live status endpoint, log entry unaffected). Typechecks clean.

## Real incident: StrictMode double-connect cutting streams ~10s in (2026-08-01)

The persistent logging above immediately paid for itself: after reports of a few more
stoppages, `data/logs/app.log` showed a clean, repeatable signature — ffmpeg exiting with
code 0 and no error message, almost exactly 10 seconds after starting, across two
completely unrelated channels. That timing consistency (not random) was the tell.

The log also showed, for both incidents, **two separate sessions starting for the same
channel a few hundred milliseconds apart** — one torn down almost immediately, one
surviving to actually get watched:

```
18:45:50.602  session A starting  (channel X)
18:45:50.838  session B starting  (same channel, 236ms later)
18:45:52.707  A started successfully
18:45:52.718  A stopped by client        <- torn down almost instantly
18:45:52.943  B started successfully      <- this is the one that got watched
18:46:02.835  B exited unexpectedly, code=0, no error   <- ~10s later
```

Root cause: `Player.tsx`'s effect issued the "start playback" `POST` directly inside
`useEffect`, and React's `<StrictMode>` (enabled in `main.tsx`) deliberately double-invokes
effects in development — mount → cleanup → mount — to catch missing cleanup bugs. That
meant every "Watch" click briefly opened **two real connections to the provider for the
same channel on the same account**, even though the throwaway one was cleaned up within
milliseconds. The theory: the provider's own concurrent/duplicate-connection policing is
what cut the surviving stream a few seconds later — plausible enough given the ~10s timing
repeated identically across two unrelated channels, which pure provider flakiness on its
own wouldn't reliably do.

Fixed with a `START_DEBOUNCE_MS` (50ms) delay before the actual `POST` is issued, checking
the cancellation flag right before firing. StrictMode's double-invoke happens synchronously
(same tick, well under 50ms), so the throwaway instance's cleanup always marks it cancelled
*before* its delayed start ever fires — only the surviving instance ends up sending a
request at all. **Verified**: re-tested the same channel-watching flow through a real
browser and confirmed (a) only one session appears in the log per Watch click, and (b) the
stream now survives past the previous ~10s cutoff (let it run ~18–20s, closed manually,
clean `stopped by client` with no unexpected exit).

**Confirmed 5+ minutes of real, uninterrupted playback** immediately after this fix
shipped (visible in the log: a session running 18:57:40→19:03:47 with a clean
`stopped by client`, no unexpected exit) — the first real end-to-end validation that the
double-connection was in fact the cause.

## Live-rewind buffer bound (2026-08-01)

While confirming the fix above, a genuinely fun side-effect got noticed: dragging the
`<video>` scrubber backward actually works, seeking into content that's already buffered
client-side rather than re-fetching from a server that's already deleted those segments
(`-hls_flags delete_segments`). Root cause, confirmed by inspecting the bundled `hls.js`
dist file directly rather than assuming: two defaults we never overrode —
`liveDurationInfinity: false` (duration is reported as "how much has been buffered so
far," not treated as endless) and `backBufferLength: Infinity` (nothing is ever evicted
from the browser's own buffer). Together, that's an accidental but real "instant rewind"
feature — genuinely more than Laomedeia has for live TV, which has no seek/rewind concept
at all there.

The unbounded part was a real concern, though, not just theoretical: using this app's own
observed bitrates against the real `sonix` account (~3.9 Mbps average, from two actual
sessions), a 3-hour game would be ~5GB sitting in the watching device's browser tab if
truly unbounded. Browsers do enforce their own internal MSE quota and will force eviction
regardless of what the app asks for, but relying on that is unpredictable — invisible
until it happens, device/browser-dependent, and possibly a stutter when it kicks in
mid-playback. Bounded it explicitly instead: `new Hls({ backBufferLength: 600 })` (10
minutes, chosen by the user) in `Player.tsx` — same rewind feature, predictable memory
ceiling instead of an implicit one. Verified playback still starts and plays correctly
with the option set (`video.readyState === 4`, advancing `currentTime`, single session
per Watch click, no unexpected exit).

## VOD (Movies) browsing + playback (2026-08-01)

Built faster than expected by deliberately **not** following the "VOD shouldn't reuse the
live-HLS approach" note above. That note was right about the *ideal* design (direct
`Range`-proxying for already-compatible files, no HLS at all) but wrong about what to
actually build first: reusing `hlsSession.ts`'s already-proven machinery — codec probing,
session lifecycle, logging, cleanup — got a fully working VOD player built in one pass
instead of standing up a second, parallel playback system. The one real change needed was
generalizing `startSession()` to a `kind: "live" | "vod"` option:

- **Live**: sliding window, `delete_segments`, `hls_list_size 6` (unchanged).
- **VOD**: no sliding window — `hls_list_size 0` (keep every segment in the manifest) and
  no `delete_segments`. ffmpeg naturally appends `#EXT-X-ENDLIST` once the whole file is
  processed, at which point hls.js reports the real, correct duration instead of the
  "keeps climbing" live behavior. Verified on a real title: MEDIA-SEQUENCE stays at 0,
  segment count only grows (12 segments at 8s in, 29 at 16s in — a real IPTV VOD source
  can be copy-remuxed well faster than real-time), never shrinks.
- `startSession()` no longer resolves stream URLs itself — that decoupling (planned
  ahead of time, not a refactor forced by VOD) let `routes/playback.ts` resolve either a
  live channel URL (`liveChannels.ts`) or a VOD URL (`vod.ts`) and hand `hlsSession.ts` a
  plain string, keeping it agnostic to *how* a URL came to be.
- **Backend**: `worker/xtreamVod.ts` (Xtream's VOD API — categories/streams/info/URL
  builder, mirrors `worker/xtreamLive.ts`'s structure), `vod.ts` (the unifying layer —
  Xtream-only, matching Laomedeia's own scope; M3U has no VOD concept of its own to
  unify against), `routes/vod.ts` (categories/streams/details), and a new
  `POST /providers/:id/vod/stream` route alongside the existing live one.
- **Frontend**: `VodBrowser.tsx`, ported closely from Laomedeia's own
  `VodBrowser.tsx` — category sidebar, poster grid, "search this category vs. search all"
  scope toggle (the "all" scope lazy-loads the entire library only on demand — a real
  account's full VOD library can run in the tens of thousands of titles, per Laomedeia's
  own PLAN.md), and a detail modal (poster, rating, year, genre, plot, cast, director).
  Dropped: resume/watch-progress tracking — a real Laomedeia feature this app has no
  progress store for yet. `Player.tsx` generalized to a discriminated `kind` prop
  (`{kind:'live'}` vs `{kind:'vod', containerExtension}`) rather than a second component,
  since everything else about playing it (hls.js setup, status polling, cleanup-on-unmount)
  is identical.

**Verified end-to-end against the real `sonix` account**: real categories (4K Movies,
Top IMDB/Oscar Movies, ...), real posters/ratings/plots/cast from TMDB-sourced metadata,
and actual playback confirmed via a real browser — both an `mp4`-container title (*The
King's Speech*) and an `mkv`-container title (*Cleopatra*) played correctly through the
same pipeline (`video.readyState === 4`, advancing `currentTime`, a real opening-titles
frame visible in a screenshot). Both packages typecheck and lint clean, no orphaned
ffmpeg processes after testing.

**Not yet built at the time: Series (TV Shows) and the Range-proxy path** — see the next
section for Series. The direct-file/Range-proxy path is still worth doing eventually for
the common case (file already browser-compatible) to skip spinning up ffmpeg at all, but
wasn't necessary to ship a working VOD player.

## Series (TV Shows) browsing + playback (2026-08-01)

Exactly the VOD pattern, one layer deeper (series → seasons → episodes instead of a flat
title list) — no new architectural decisions needed, everything from the VOD pass reused
directly:

- **Backend**: `worker/xtreamSeries.ts` (Xtream's Series API, mirrors `xtreamVod.ts`),
  `series.ts` (Xtream-only unifying layer, same reasoning as `vod.ts`), `routes/series.ts`
  (categories/list/details-with-seasons-and-episodes), and
  `POST /providers/:id/series/stream` (body `{episodeId, containerExtension}`) — an
  episode is treated as a `kind: "vod"` session in `hlsSession.ts` (finite content, same
  as a movie), just with its own `series-<providerId>` codec-cache prefix so an episode id
  can never collide with a numeric VOD `streamId` or a live channel id.
- **Frontend**: `SeriesBrowser.tsx`, ported closely from Laomedeia's own component —
  identical category-sidebar/poster-grid/search-scope shape to `VodBrowser.tsx` (Laomedeia
  literally reuses the same `.vod-panel`/`.vod-grid`/`.vod-poster-*` CSS classes for
  both; this app's `series.css` does the same, only adding what's actually
  series-specific: season tabs and the episode list). `Player.tsx`'s discriminated `kind`
  prop gained a third variant (`"series"`), sending `{episodeId, containerExtension}` to
  the new route — everything else about playing it is identical to VOD.

**Verified end-to-end against the real `sonix` account** — with a genuine, useful
surprise along the way: the first three shows tried (a 1968 classic, a 2026 Netflix
release, another 2026 release) all failed, each for a different real reason —
`ffprobe`'s error cleanly reported the provider's own CDN returning `400 Bad Request`
directly (confirmed independently with a plain `curl -L`, which showed the Xtream
redirect landing on a dead `t11111vod.xyz` mirror), and a separate title's fetch timed
out entirely (confirmed with a raw `curl` to the same URL, which also hung). Both are
genuine provider-side content-availability issues, not app bugs — and both were
immediately distinguishable *as* provider-side from the error message alone, which is
exactly what the "Playback logging" work earlier was for. A fourth show (*Please Like
Me*) played correctly end-to-end: real season tabs, real per-episode duration metadata,
`video.readyState === 4`, advancing `currentTime`, confirmed via a real browser
screenshot. Also incidentally validated the audio-transcode design against a genuinely
different codec than anything seen so far — this episode's audio was `eac3` (Dolby
Digital Plus, not AAC at all), correctly identified as needing transcode rather than
assumed safe. Both packages typecheck and lint clean; no orphaned ffmpeg processes after
testing (one test-driven leftover, from the test script closing the browser before the
unmount's async `DELETE` call completed, cleaned up manually — the same "idle sweep is
the backstop for hard refresh/tab close" scenario `Player.tsx` already documents, not a
new bug).

**Not yet built: the direct-file/Range-proxy playback path**, same note as VOD's section
above — still the more efficient long-term design for already-compatible files, still not
necessary yet.

## Resume/watch-progress tracking (2026-08-01)

The one Laomedeia feature both the VOD and Series sections above explicitly dropped for
not having a progress store yet.

- **Backend**: new `watch_progress` table (`providerKey`/`mediaType`('vod'|'episode')/
  `mediaId` primary key, `positionSecs`/`durationSecs`) — `server/src/progress.ts`'s
  `getProgress`/`saveProgress`, exposed at `GET`/`PUT /providers/:id/progress/:mediaType/
  :mediaId`. Mirrors Laomedeia's own rule for what's *not* worth saving: a position under
  10s, or within 30s of the end, gets deleted instead of persisted (otherwise a barely-
  started or just-finished title leaves a stale "resume" entry forever — nothing else ever
  clears one).
- **Frontend**: `Player.tsx` accepts an optional `startPositionSecs` for `kind="vod"`/
  `"series"`; `VodBrowser.tsx`'s detail modal and `SeriesBrowser.tsx`'s per-episode rows
  (a new `EpisodeRow` subcomponent, fetched lazily — only the selected season's episodes
  are ever mounted, no bulk-progress endpoint needed) show "▶ Resume at H:MM" + "Play from
  start" instead of a single "▶ Play" once a saved position exists. While playing, position
  is PUT back every 20s plus once more on close/unmount.

**Real bug found via browser testing, not just typecheck/lint**: the first implementation
seeked client-side (`video.currentTime = startPositionSecs` on the first `loadedmetadata`)
— this silently landed in the wrong place. `ffmpeg` always starts transcoding a VOD/series
session from position 0; the HLS playlist it serves in the first second or two only covers
those first few seconds of *real* content, nowhere near a non-trivial resume point yet.
`video.currentTime` doesn't error when asked to seek past the currently-available range —
it just clamps down into whatever tiny amount exists so far, silently. Reproduced twice
against a real 53-minute title: resumed at a saved "0:32", the seek clamped to
`currentTime≈6.2s` (matching the ~6s of segments ffmpeg had produced by then) and got
stuck there — and because 6.2s is under the 10s "not worth saving" threshold, closing that
broken session *deleted* the previously-good 0:32 progress as a side effect.

**Fix**: the resume seek moved server-side. `hlsSession.ts`'s `StartSessionOptions` gained
`startOffsetSecs`, passed to `ffmpeg` as an input-side `-ss <secs>` (before `-i`, so the
demuxer seeks before decoding starts rather than decoding-and-discarding from 0 — no slow
real-time fast-forward through everything before the resume point). The returned HLS
stream now already begins at the resume point from its first segment; `Player.tsx` just
plays it from 0 like any normal session, with no client-side seek at all. Every position
it reports back for progress-saving adds `resumeOffsetSecs` back on top of
`video.currentTime`/`video.duration`, so saved positions stay relative to the real file
regardless of where a session was told to start. Re-verified: resume landed at the correct
absolute position and kept advancing normally; a second resume-and-close correctly showed
the accumulated time instead of the old bug's near-zero wipe.

**Secondary bug found and fixed along the way**: `stopSession()` called `rm(session.dir,
...)` immediately alongside `SIGTERM`, racing ffmpeg's own shutdown — ffmpeg can still be
writing new segment files during its ~2-3s flush/grace period, so the sweep could finish
before ffmpeg stopped writing, leaving the session directory non-empty (confirmed on disk:
several leftover `data/hls-sessions/<uuid>/` directories from finished playback that were
never actually cleaned up). Fixed by moving the `rm()` into the process's own `exit`
handler, so cleanup only runs once ffmpeg has actually stopped.

**Not yet built**: a "Continue Watching" rail — there's no Home screen yet, so this only
answers "does this exact title/episode have a saved position" for its own detail modal,
not "show me everything I have in progress across the library."

## Live TV preview + Live TV/Guide consolidation (2026-08-01, superseded same day)

**Superseded a few hours later by "Guide-centric Live TV" below** — after seeing this in
the browser, the follow-up feedback was "still not quite what I was thinking, the Guide
screen is closest to it," landing on a different screen entirely (the Guide grid with a
permanent mini-player docked above it) rather than the standalone `LiveTV.tsx` list this
section describes. Left in place as a historical record of the interaction pattern that
*did* carry over unchanged (`compact`/`onPromote`/`previewTimeoutSecs` on `Player.tsx`) —
only `LiveTV.tsx`/`live.css` themselves and their floating-dock positioning were replaced.

Prompted by comparing Live TV's plain list against Laomedeia's own Guide screen (a
category-filtered, scrollable/searchable channel-first layout) and asking whether the app
really needed two separate top-level screens for "pick a channel" (`LiveChannels.tsx`) vs.
"what's on" (`EpgGuide.tsx`). Decision: replace `LiveChannels.tsx` outright with a new
`LiveTV.tsx` built around a preview-then-promote interaction — single click starts a small
floating preview, a second click (or the "▶ Watch" button, or clicking the preview video
itself) promotes it to full playback. `EpgGuide.tsx`/the Guide tab is **intentionally left
separate for now** — its schedule timeline is a genuinely different job than channel
browsing, folding it into a panel on this same screen is a reasonable next step but out of
scope for this pass.

- **`LiveTV.tsx`**: same category-sidebar/filterable-list/search-scope shape as
  `VodBrowser.tsx`/`SeriesBrowser.tsx` (reuses `vod.css`'s panel/sidebar/toolbar classes;
  `live.css` only adds the plain channel-row list — channels don't have posters worth a
  grid). Clicking a row starts/switches the preview; clicking the same row again promotes.
- **`Player.tsx`** gained `compact`/`previewTimeoutSecs`/`onPromote` props. Promoting is
  deliberately just a prop flip on the *same* component instance (parent never changes
  `providerId`/`mediaId`/`kind`, only `compact`) — React reuses the instance, so the
  running session (and its ffmpeg process) is never torn down and restarted. Compact mode
  hides native `<video controls>`, floats via a new `.player-compact` CSS rule (`position:
  fixed`, bottom-right corner, so it overlays the channel list rather than pushing layout
  around), and shows a "▶ Watch" button alongside the usual Close.
- **Auto-close for an unpromoted preview**: purely client-driven — `Player.tsx` arms a
  `setTimeout(() => onClose(), previewTimeoutSecs * 1000)` while `compact` is true, cleared
  automatically the instant `compact` flips to false (promoted) or the component unmounts.
  No server-side "preview" session concept needed at all: if the tab/browser dies before
  the timer fires, the server's existing idle sweep (no segment fetches for 30s) is the
  same backstop it already is for every other session.
- **`previewTimeoutSecs` is a user setting, not a hardcoded constant** (there's no single
  right answer — a fast channel-surfer wants it short, someone lingering to decide wants it
  longer): new singleton `player_settings` table/`GET`+`PUT /config/player`, edited via a
  plain number input at the top of the Live TV screen (5–300s range, default 20s).

**Verified end-to-end against the real `sonix` account** via Playwright: category/channel
list/filter all work; clicking a row produces a real, actually-playing preview (confirmed
`videoWidth`/`videoHeight`/advancing `currentTime`); promoting via either the same-row
click or the "▶ Watch" button confirmed to reuse the same session (no new `POST
/providers/:id/live/stream` at the moment of promotion, no restart/black-flash, playback
continues smoothly); the auto-close timer fired within ~50ms of the configured value (set
to 5s for the test) and the corresponding `DELETE /stream/:id` was observed at the right
time — not immediate, not never. No console errors, no orphaned ffmpeg processes, no
leftover session directories.

**Minor observation, not a new bug**: this testing incidentally exposed that
`START_DEBOUNCE_MS`'s StrictMode-double-invoke mitigation (see `Player.tsx`, "Playback
logging" section above) isn't 100% airtight under real network latency — one run showed a
throwaway instance still open (and immediately close) a real connection within the same
click. Harmless (cleaned up within the same click, dev-only, never occurs in a production
build) — the code comment was softened to stop overclaiming an absolute guarantee.

## Guide-centric Live TV (2026-08-01)

The actual landing design, after seeing the standalone `LiveTV.tsx` screen above and
deciding the Guide grid — wider, with a *permanent* mini-player docked above it and a
details panel beside that — was the better fit. `LiveTV.tsx`/`live.css` are deleted; there
is no more separate "Live TV" nav tab, just one "Live TV / Guide" entry pointing at
`EpgGuide.tsx`. The `compact`/`onPromote`/`previewTimeoutSecs` mechanism on `Player.tsx`
carried over unchanged — only where/how it's docked changed.

- **Full-bleed width**: `EpgGuide.tsx` used to visibly sit inside the app's normal
  ~1126px-wide centered shell (`#root`'s fixed width) — looked like it was using maybe 40%
  of a wide screen. `.guide-container` (`index.css`) now breaks out of that with the
  standard "full-bleed on a centered parent" trick (`width: 100vw; position: relative; left:
  50%; margin-left: -50vw;` — vw units reference the viewport directly, bypassing the
  parent's constrained width entirely). Deliberately scoped to just this one page: a
  time-based grid genuinely benefits from the extra width (more hours visible without
  scrolling); the narrower cap still suits the form/poster-grid pages fine, so `#root`
  itself wasn't touched.
- **Permanent mini-player + details row** (`.epg-player-row`, above the schedule grid, below
  the toolbar): a `~320px` `Player` in `compact` mode on the left (or a placeholder box
  before anything's picked), program details (title/time/description, the same markup the
  old bottom-only detail panel used) to its right. `flex-wrap` does the layout work for
  promoting — a compact dock leaves room for details beside it, but a promoted (`720px`)
  player doesn't fit next to details at any reasonable width, so the row wraps and details
  fall below it instead. No JS branching on layout needed for that, just CSS.
- **Click behavior**: clicking a channel's name cell plays whatever's live on it right now
  (looked up from the already-fetched program cache) and shows that program's details;
  clicking a specific program block (any time slot, past/present/future) shows *that*
  program's details and switches the mini-player to its channel. Both share one
  `selectChannelAndProgram` helper that only resets `promoted` (shrinks an expanded player
  back down) when the channel is actually changing — re-clicking the currently-playing
  channel, or another block in the same row, never restarts or un-expands it. A picked
  search result does the same (resolves its channel via the existing `channelsByEpgId`
  reverse lookup and starts the preview) instead of only jumping the grid to that time slot.
- **`previewTimeoutSecs` setting moved** from the old `LiveTV.tsx` into this screen's own
  toolbar (`.epg-timeout-label`/`-input`) — same `GET`/`PUT /config/player` backing it,
  no server changes needed.

**Verified end-to-end against the real `sonix` account** via Playwright (1600×1000
viewport): full-bleed width confirmed (grid rendered at exactly `window.innerWidth`);
category filter confirmed (4,518 → 54 channels); clicking a channel cell started real
playback (advancing `currentTime`) and showed the correct live-now program; clicking a
different channel's program block switched both the details and the mini-player with
exactly one new session started; re-clicking the already-playing channel was confirmed a
no-op (no new session, no un-promoting); promoting via the "▶ Watch" button confirmed to
continue the same session (no new `POST`, smooth playback through the transition, stayed
expanded on a further re-click); the moved auto-close setting saved correctly and fired at
the right time; search-result selection correctly started the mini-player too. Zero console
errors.

**Real gap found during this verification, not yet fixed**: if a session's id falls out of
the server's in-memory `sessions` map — the only case seen so far is a dev-server restart
(`tsx watch` reloading on file save) killing that map while ffmpeg keeps running underneath
it, though anything else that clears the map without the process actually exiting would
have the same effect — `stopSession()` (`hlsSession.ts`) no-ops (`if (!session) return`)
instead of still trying to reap the orphaned process/directory. The idle sweep has the same
blind spot: it only iterates the in-memory map, never cross-checks actual `data/hls-sessions/`
directories or running `ffmpeg` processes against it. Two such orphans turned up during this
round of testing and had to be cleaned up manually (`rm -rf` + confirming no matching
process). Rare in production (a long-running process doesn't restart itself the way `tsx
watch` does in dev), but a real, unbounded resource leak if it ever happens outside dev —
worth a proper fix (e.g. an on-startup reconciliation pass over `data/hls-sessions/` against
`ps`) at some point, not done here.

## Stats for nerds + log download (2026-08-01)

Two small diagnostics features, both requested together and both aimed at the same
underlying need: being able to see what the server is actually doing without SSHing in,
and being able to hand off evidence when something goes wrong (the concrete case raised:
daughter hits a playback problem on her device and needs an easy way to send logs back).

New "Diagnostics" tab (`web/src/pages/Diagnostics.tsx`), polling a new `GET /stats`
(`server/src/routes/stats.ts`) every 5s:
- Process uptime + RSS/heap memory.
- Every actively-tracked playback session: provider/media id, kind, status, ffmpeg pid, age,
  idle time, and the video/audio passthrough-vs-transcode decision — `hlsSession.ts`'s
  `Session` type gained `startedAtMs`/`videoPassthrough`/`audioPassthrough` fields to make
  this possible (the codec decision was already made per-session, just not retained anywhere
  after the ffmpeg args were built).
- **Orphaned session directories** — directly answers open question #6 below, at least on
  the disk side: `listOrphanedSessionDirs()` reads `HLS_DATA_DIR` and reports any directory
  name with no matching entry in the in-memory `sessions` map. Can't see an orphaned ffmpeg
  *process* itself this way (once the map entry is gone, this process has no pid to check
  against), but a leftover directory is a reliable proxy that something wasn't cleaned up —
  confirmed clean (`orphanedSessionDirs: []`) in normal operation via curl.

Log download: `GET /logs/download` concatenates `logger.ts`'s existing rotated + current log
file (oldest first) and returns it as a `text/plain` attachment. `logger.ts` already wrote a
real on-disk log for its own reasons (found via a real incident — see its own top comment) —
this just exposes what was already there; no new logging infrastructure needed. Client side
is a plain `<a href="/api/logs/download" download>` rather than a fetch+blob dance, since the
browser's native download handling already does exactly what's wanted here.

Verified against the real sonix account: started a real live session via curl, confirmed it
appeared in `/stats` with the correct pid/age/codec info and in the Diagnostics table
(screenshot), stopped it and confirmed the table/orphan list both went back to empty,
and confirmed the download link actually triggers a browser download (Playwright
`waitForEvent("download")`) with the expected filename and non-trivial size.

## Recording support (2026-08-01)

Recording itself is entirely iptv-recorder's job — storage, retention, the scheduler/worker
that actually runs ffmpeg against a channel. This app never touches a recording file on
disk directly; it's purely an HTTP client of iptv-recorder's own `/recordings` API (decision
#2's deferred item, built now that the core viewer is solid). Ported client-side UX from
Laomedeia (`src/components/RecordDialog.tsx` + `RecordingsBrowser.tsx`), adapted from
Electron IPC to plain REST, matching iptv-scheduler's own sibling-service pattern.

**Server** (`server/src/recorderClient.ts`, extended): added the recording-shaped types and
functions iptv-recorder's API exposes — `createOneOffRecording`/`createRecurringRecording`
(one `POST /recordings`, branching on `recurrence` vs `startTime`/`endTime`, same as
iptv-recorder's own route), `listRecordings`/`getRecording`/`cancelRecording`,
`listRecurringRules`/`cancelRecurringRule`/`skipOccurrence`. `rawFetch` became a general
`recorderRequest()` supporting POST/DELETE bodies, and a new `RecorderApiError` (status +
message) lets route handlers preserve iptv-recorder's own 409 hard-reject reasons (disabled
provider, storage exhaustion, concurrent-stream/same-channel conflicts) instead of
collapsing every failure to a generic error.

New `server/src/routes/recordings.ts` proxies all of the above under the same flat
`/recordings` paths iptv-recorder itself uses (not nested under `/providers/:id`, since
`providerId` is already a body/query field in iptv-recorder's own resource model — mirroring
that beats inventing a second shape). `RecorderNotConfiguredError` already gates every route
correctly with no extra check needed: local mode never has a recorder connection configured
in the first place, so "recording requires recorder mode" falls out for free.

**Playback — the one real new problem, not just a proxy.** iptv-recorder serves a finished
recording as a single raw MPEG-TS file (`GET /recordings/:id/file`, Bearer-authenticated).
No browser can play that directly (same reason live channels already go through
ffmpeg→HLS instead of a raw passthrough — MPEG-TS isn't in any browser's <video> container
list). Solution: reuse the exact same `hlsSession.ts` pipeline used for live/VOD, with the
recording's authenticated file URL as ffmpeg's input:

- `StartSessionOptions` gained `headers?: Record<string, string>`; `codecProbe.ts` gained a
  `headerArgs()` helper (`-headers "Key: Value\r\n"`, ffmpeg/ffprobe both accept it via
  shared libavformat) threaded through both `ffprobeStreams` and the ffmpeg spawn itself —
  a live channel/VOD title's URL always carries its own auth (Xtream username/password in
  the URL, or nothing for public M3U), so nothing needed this until now.
- `recorderClient.getRecordingStreamSource(id)` returns `{ url, headers: { Authorization:
  "Bearer <key>" } }` — never fetched by this app's own process; handed straight to ffmpeg
  the same way a resolved provider streamUrl already is.
- `POST /recordings/:id/stream` (this app's own addition, not an iptv-recorder passthrough):
  checks the recording is `completed` with a `filePath`, then starts a `kind: "vod"` session
  (finite length, real `#EXT-X-ENDLIST`, same as any VOD title) with that source. Returns
  the same `{sessionId, playlistUrl}` shape as every other stream-start endpoint.
- `Player.tsx` gained a `kind: "recording"` variant (just `providerId`/`mediaId` — no
  `containerExtension`, no resume yet, see Open Question #8) that POSTs there instead.

**Web UI:**
- `RecordDialog.tsx` (new) — one-off vs. recurring toggle, day-of-week bitmask picker for
  recurring, ported near-verbatim from Laomedeia's own dialog. Reuses `.vod-scope-toggle`/
  `.vod-scope-btn` for both the mode toggle and the day picker rather than inventing new
  classes.
- `Recordings.tsx` (new tab) — Recording Now / Scheduled / Recurring Rules / Completed /
  Failed sections, same shape as Laomedeia's `RecordingsBrowser`. Shows a plain "requires
  recorder mode" message (fetches `/config/provider-source` itself, same per-page pattern
  every other screen here uses) when not in recorder mode, rather than hiding the tab
  entirely. Completed rows get a "▶ Play" button rendering `<Player kind="recording">`
  inline below the list (same pattern as `VodBrowser.tsx`'s own play button).
- `EpgGuide.tsx` — a "⏺ Record" button next to the selected program's details (only when
  `recorderMode` and the program's channel resolves to a live channel), opening
  `RecordDialog` prefilled with that program's own start/stop as the one-off window —
  exactly where Laomedeia put it (`EpgGrid.tsx`'s detail panel, next to "▶ Watch").

**Verified against the real sonix account + a real, already-running iptv-recorder:**
started playback of an actual completed recording (a real college football broadcast) and
confirmed it played correctly in-browser (video decoding, screenshot); scheduled a real
one-off recording from the Guide's "⏺ Record" button end-to-end (prefilled dialog → submit
→ appeared in Recordings' Scheduled section → Cancel button → confirmed removed), twice,
cancelling both test recordings immediately after confirming each step rather than letting
them actually record. Both packages typecheck and lint clean, no console errors in any of
the above.

**Found in passing, not introduced by this change:** testing surfaced three real orphaned
`data/hls-sessions/` directories (~1.2GB) from earlier `tsx watch` restarts during this same
session's server-side edits — exactly the gap the Diagnostics stats panel (built earlier
today) was meant to surface, and it did, correctly. Cleaned up manually; the underlying gap
(Open Question #6) is unchanged.

## Guide UI polish (2026-08-01)

Five fixes from real tablet screenshots (portrait and landscape), all against the Guide
screen — the app's primary live-viewing surface, so its rough edges show up fastest there.

**1. EPG auto-refresh when stale.** Real incident: a 5-hour-old refresh had 71,491 programs
cached; a manual force-refresh immediately after produced 103,330 — a genuine ~30% gap, not
a loading-timing artifact. Investigated rather than just building around it: this provider's
XMLTV feed is a real, fixed-size sliding window — even a *fresh* full ingest only covers
about 2.4 days total (confirmed via `/epg/bounds`: `maxStopMs - minStartMs` ≈ 57 hours), not
"a couple of days ahead of whenever it was last checked." A refresh landing with little
runway left before "now" catches up to the window's edge is a real, if mundane, provider-side
timing thing (their feed's own coverage at the moment it happened to be fetched), not a bug
in the ingest code — `state: "idle"` with a valid `lastRefreshMs` rules out a truncated
download or failed ingest (both land in `state: "error"` instead, see `epg.ts`). Fix: EpgGuide
now checks `bounds.maxStopMs` against `Date.now()` (1h margin) after every bounds fetch and
auto-triggers a forced refresh — once per provider selection (a ref guard, not state, so the
30s status poll doesn't retrigger it) — the same `handleRefresh()` a manual click already
uses. Self-heals from this class of gap continuously instead of needing a human to notice a
blank grid.

**2 & 5. Preview timeout removed; "▶ Watch" now means real fullscreen.** These turned out to
be the same underlying simplification. Previously: compact preview → click "▶ Watch" →
`onPromote` flipped a `promoted` boolean → a bigger-but-not-fullscreen third card state,
plus a `previewTimeoutSecs` auto-close timer for the unpromoted case (a user setting via
`/config/player`). All of it — `player_settings` table, `getPlayerSettings`/
`setPlayerSettings`, `GET`/`PUT /config/player`, the toolbar's "Preview auto-close after"
input, `promoted` state, `onPromote` prop — is gone. `Player.tsx`'s "▶ Watch" button (and
clicking the compact video itself) now calls `videoRef.current.requestFullscreen()` directly;
`isFullscreen` is tracked off the real `document.fullscreenElement`/`fullscreenchange` event,
not a boolean this component invents, so it also correctly reflects Esc/back-gesture exits.
`controls={!compact || isFullscreen}` — native controls only appear once fullscreen actually
engages. The compact dock now always plays indefinitely until Close, a different channel
selected, or the server's idle sweep (existing backstop, unchanged). Table dropped via a real
migration (`drizzle/0004_thick_jocasta.sql`, `DROP TABLE player_settings`), not just unused
code left in place. Verified: clicking "▶ Watch" puts the actual `<video>` element into
`document.fullscreenElement` (Playwright-confirmed) with zero intermediate card state.

**3. Landscape tablet vertical space.** Three changes: the `<h1>iptv-web-player</h1>` heading
is gone everywhere (App.tsx and its now-dead CSS rules) — it cost real vertical space for a
label that added nothing once the nav row is right there. The Guide's own "Updated Xh ago ·
N channels · N programs" status line moved out of its own toolbar row and into App.tsx's nav
row instead (`EpgGuide` takes an `onStatusTextChange` callback, App.tsx renders it via
`.nav-status`, cleared on unmount) — a deliberate narrow one-way lift, not shared app state,
consistent with every other page here still fetching its own data independently. And
`.player-compact`'s width changed from a flat `320px` to `min(320px, 34vh)` — on a normal
desktop window this is unchanged, but on a short landscape tablet viewport it keeps the
preview from eating a disproportionate share of the little vertical room left for the grid.
Verified against the tablet's actual reported resolution (2560×1600 physical, tested at the
1280×800 CSS viewport that implies): 1 grid row visible before this session's changes → 3+
rows after.

**4. Diagnostics as a non-navigating popover.** The full Diagnostics tab is a real route —
switching to it unmounts whatever `<Player>` is running in the Guide's dock, stopping
playback, which made it useless for "what is this stream actually doing right now." New
`StatsPopover.tsx`: a small `position: absolute` card (not a full-page backdrop modal),
rendered as a *sibling* of the still-mounted `<Player>` inside `.epg-player-dock`, triggered
by a small "ⓘ" button overlaid on the dock's corner. Never touches the route/tab, so opening
it can't stop anything — verified the video keeps visibly playing behind it. Fetches `/stats`
every 3s while open, matches the current session by `providerId`+`channelId` (no sessionId
plumbed out of Player.tsx for this — correlating on the same fields `/stats` already exposes
was enough), plus a compact one-line server summary. Deliberately doesn't link over to the
full Diagnostics tab — that link would just reintroduce the exact problem being fixed here.
Positioned to the right of the dock (into the details panel's own empty space), not on top
of the video — the first version overlapped the video, which defeated the visual point even
though playback itself was never actually affected.

**Also fixed in passing:** the EPG toolbar's own wrapping (a second, cause of the original
report on 5026) — removing the timeout input and status span freed width, but at the tablet's
actual portrait CSS width the row still wrapped by a hair (just the Refresh button, alone,
looking like a leftover). Trimmed a few toolbar min/max-widths (day label, category select,
search input) and gave Refresh `margin-left: auto` so it either fits on one line (confirmed at
800px CSS width) or, if a narrower device ever wraps it again, sits deliberately right-aligned
rather than stranded at the left margin.

All five verified together via Playwright against real tablet viewport dimensions (portrait
800×1280 and landscape 1280×800 CSS px, both at the tablet's actual 2x DPR) and the real
sonix account: toolbar fits on one line, auto-refresh fires and completes, grid shows 3+ rows
in landscape, fullscreen engages on the real `<video>` element, stats popover shows live
session data without interrupting playback. Both packages typecheck and lint clean, no
console errors anywhere in the above. Also found (not introduced by this change, same root
cause as the earlier Diagnostics work) one more orphaned `data/hls-sessions/` directory from
a `tsx watch` restart mid-testing — cleaned up manually, same unchanged Open Question #6.

## Guide UI polish, round 2 (2026-08-01)

A real regression from the first "Guide UI polish" pass, found via another tablet
screenshot: the earlier verification happened to test with no program selected or a short
description, so it missed that `.epg-player-details` had no height cap — a real program
description (often 2-3 sentences) plus the "⏺ Record" button made the details panel taller
than the video dock next to it, and since they're flex siblings, the whole `.epg-player-row`
stretched to match, costing back most of the grid space the previous round had just
reclaimed. Fixed: `.epg-player-details` gets `max-height: 30vh; overflow-y: auto`, and
`.epg-detail-desc` gets a 3-line `-webkit-line-clamp` so the common case never needs to
scroll at all. Verified: a real 2-sentence description no longer pushes the grid down to
zero visible rows.

Three more fixes from the same round of feedback:

- **EPG horizontal scroll now opens at the current hour, not "now minus 15 minutes."**
  `scrollToCurrentHour()` (used for initial load and the "Now" button) lands on the hour
  boundary exactly; `scrollToTime()` (search results, jump-to-program) keeps its 15-minute
  lead-in, since landing exactly on a searched program's start edge with zero context is a
  different, worse UX than for "now." Day navigation is also clamped to never go earlier
  than today, regardless of how far back the guide's own cached data reaches — there's no
  real use case for scrolling into already-aired content on a live-TV screen. (Manually
  scrolling backward *within* today, e.g. to see what just aired on the current channel, is
  still possible — only the day-boundary ◀ button and the default/auto scroll position
  changed, not free scroll gesture within the visible day.)
- **The "Updated Xh ago" status line moved again** — round 1 lifted it into the shared nav
  row; this round removed it from being permanently visible at all, replacing it with a
  small "ⓘ" button next to the "CHANNEL" grid-column header that opens an on-demand popover
  (reusing `.stats-popover`'s card styling, positioned differently) with the same status
  text plus a "Refresh now" button. Round 1's nav-row lifting mechanism (`onStatusTextChange`
  prop, `.nav-status` CSS) is fully removed, not left dead — this round's approach replaced
  it rather than adding alongside it.
- Toolbar width trims from round 1 carried forward unchanged.

**Still open, deliberately not built yet — see the conversation, not just PLAN.md, for full
context:** collapsing the top app nav (and possibly the EPG's own toolbar) behind a
hamburger-style menu, and persisting UI preferences (default start tab, last-selected
category per screen) across reloads. The latter raises a real multi-user question — Skip and
his daughter both use the same deployed instance from different devices — that's still being
discussed: `localStorage` cleanly solves per-browser UI preferences with zero auth needed,
but true per-user separation of *recordings* (not just UI prefs) would be a materially
bigger feature (real identity, likely an iptv-recorder schema change to own/tag recordings
per person) that's being deliberately scoped as a separate decision, not bundled in here.

## Persisted UI settings + hamburger nav (2026-08-01)

Two things, both from the same conversation: "remember some UI choices across reloads" and
"the Guide still doesn't show enough grid on a landscape tablet."

**Persistence: `localStorage`, not a server setting — and deliberately not full auth.** The
real question underneath "where do I save this" was multi-user: Skip and his daughter both
use the same deployed instance from different devices, and a server-side singleton setting
(the pattern every other setting in this app uses) would leak one's choices into the
other's. `localStorage` sidesteps that for free — it's inherently per-browser/per-device
already, so no auth system was needed for *this* — new `web/src/localSettings.ts` (thin
try/catch-wrapped get/set helpers, namespaced keys) holds:
- **Start screen** (`getStartTab`/`setStartTab`) — which tab loads first. Chosen from a
  small "Start screen" `<select>` living inside the app-nav hamburger panel (see below), one
  of `guide | vod | series | recordings` (Providers and Diagnostics are deliberately not
  offered — neither is a sensible place to land by default). `App.tsx`'s `tab` state now
  initializes from this instead of always `"providers"`.
- **Last category per screen** (`getLastCategory`/`setLastCategory`, keyed `guide | vod |
  series`) — `EpgGuide.tsx`/`VodBrowser.tsx`/`SeriesBrowser.tsx` all restore the stored id
  once their real category list loads, but only if it still exists in that list (a provider
  switch, or the category itself disappearing, both just fall back to the old default —
  "All categories" for Guide, first category for VOD/Series — same as if nothing had ever
  been chosen).

**Explicitly out of scope, and why:** true per-*person* separation of **recordings** (not
just UI prefs) is a materially different, bigger feature — real identity, and very likely an
iptv-recorder schema change (an owner/profile column on its `recordings` table, filtered by
whoever's asking) — deliberately not bundled into this change. If wanted later, a lightweight
no-password profile picker would be enough for a home LAN tool; doesn't need real
authentication.

**Hamburger nav, both levels (the user's explicit choice over two lighter options — see the
conversation, not just this file).** Two separate collapsible panels, not one shared
mechanism (each has different content and different close-on-click semantics, so no generic
component was worth extracting for just two uses):
- **App-level** (`App.tsx`): the `Providers/Guide/Movies/TV Shows/Recordings/Diagnostics`
  row collapses behind a single `☰` + the current tab's name, with the "Start screen"
  preference living at the bottom of the same dropdown panel — a natural, coherent home for
  it. Click-outside-to-close via a `mousedown` listener on `document`, standard expectation
  for a menu especially on a touchscreen.
- **Guide-level** (`EpgGuide.tsx`): the day-nav (◀/▶), provider/category selects, search
  input, and Refresh button all collapse into their own `☰` panel (right-aligned, mirroring
  the app nav's left alignment) — only the day label and "Now" button stay permanently
  visible in the toolbar itself. Same click-outside pattern, independent open/close state
  from the app nav.

Combined with the two earlier "Guide UI polish" rounds' fixes (capped details panel, no more
h1, current-hour default scroll), the landscape-tablet grid went from 0 visible rows (with a
program selected, before today) to **6 rows with nothing selected, 3 rows with a full
program description + Record button showing** — verified via Playwright at the tablet's
real viewport dimensions. Persistence verified end-to-end: set start screen to Recordings via
the hamburger, confirmed the value landed in `localStorage`, reloaded the page, confirmed the
app opened directly on Recordings. Both packages typecheck and lint clean, no console errors.

## Guide UI polish, round 3 (2026-08-01)

The user's own framing of this round: "It's OK that we have to iterate over this. UI is
always the hardest part." Round 2's two-hamburger toolbar (app nav + a separate Guide
toolbar) was itself replaced — search moving into a menu turned out to be the wrong call
("I do think it will be annoying"), and there was still more chrome above the grid than
necessary.

**No more calendar-day pagination at all.** The Guide used to be scoped to one day at a time
(Prev/Next day buttons, a `dayStartMs`/`dayEndMs` pair reset on every day change). Given
round 1 already established this provider's real EPG window is only ~2.4 days total and
horizontal scroll makes day-by-day paging redundant, the whole model changed to one
continuous scrollable window: `windowStartMs` (the current hour, captured once per provider
selection — not re-derived every tick, so it's a fixed backward scroll limit rather than a
constantly-advancing one) through `windowEndMs` (`bounds.maxStopMs` — the real end of
available data, not an arbitrary midnight cutoff). Scrolling earlier than `windowStartMs` is
now impossible for free (a scrollable container's `scrollLeft` can't go negative — no custom
clamping code needed), and scrolling forward now reaches the actual end of the guide's data
instead of stopping at a same-day boundary. Removed entirely: Prev/Next day buttons, the
"Now" button (nothing to jump back to — position 0 already *is* the current hour by
construction), the day label, `changeDay`/`jumpToNow`/`scrollToCurrentHour`/`minDay`/
`maxDay`/`DAY_MS`/`localMidnight`/`nextMidnight`.

**One combined hamburger, not two.** `.epg-menu-col` sits at the top-left of
`.epg-player-row` itself — no separate toolbar row above it — "indenting" the preview dock by
just its own width, per the user's explicit description. Its panel now holds everything that
used to be split across App.tsx's nav row and the Guide's own toolbar: nav links, provider/
category pickers, the "Start screen" preference, and a "Refresh guide" button. App.tsx's own
nav is hidden while the Guide tab is active (`tab !== "guide"` gate) to avoid two stacked
hamburgers — every other screen keeps it unchanged. New `navConfig.ts` holds the shared
`Tab`/`TAB_LABELS`/`TAB_ORDER`/`StartTab` types+data so both App.tsx and EpgGuide.tsx build
their (structurally identical, differently-hosted) nav-links list from one source. `tab`/
`onSelectTab`/`startTabPref`/`onStartTabChange` are passed down as props — the one deliberate
exception to this page's usual "fetch everything itself" independence, needed only so its
embedded menu can act on tab-switching state that genuinely lives in App.tsx.

**Search stays permanently visible** in its own minimal single-input row above the player
row — the one control explicitly *not* collapsed, reversing round 2's choice once real usage
showed hiding it wasn't worth the space saved.

**The old day label moved into the "ⓘ" Guide-info popover** (next to "CHANNEL") as a
"Showing Sat, Aug 1 12:00 PM – Sun, Aug 2 04:00 PM" range line, alongside the existing
Updated/channel/program-count text — informational, on-demand, not permanently on screen.

Net result on the real tablet, verified via Playwright at its actual viewport dimensions:
landscape went from 0 rows (round 2, program selected) to 6 rows idle / 3+ rows with a full
description+Record button showing; portrait went from 1 row (session start) to ~14 rows.
Also verified: horizontal scroll physically can't go negative (confirmed via a forced
`scrollLeft = -500` attempt clamping to 0), forward `scrollWidth` reflects the real bounds-
derived window instead of a fixed 24h day, search still triggers results and clicking a
result correctly scrolls to and selects the right program, the combined menu's every item
(nav links, category, start screen, refresh) works, and non-Guide tabs still show their own
unchanged nav. Both packages typecheck and lint clean, no console errors.

## Guide UI polish, round 4 (2026-08-01)

Requested changes were small — move search into the details column (bottom-aligned, matching
an annotated screenshot), close the remaining top/bottom gaps around the Guide. Chasing the
gaps down turned up two real, previously-hidden bugs, both fixed the same round.

**The gaps: `.guide-container`'s `height: calc(100vh - 220px)` was a magic number that had
already gone stale twice** (rounds 1-3 kept shrinking the chrome above it without ever
updating 220). Replaced with real flex-fill sizing — `main` and `.guide-container` both
`flex: 1; min-height: 0`, `.guide-container` also gets `margin: -32px -50vw` (the vertical
component cancels `main`'s own padding so the preview reaches the literal top of the
viewport; the horizontal component is the pre-existing full-bleed trick, unchanged). No
magic number anywhere in the chain now, so it can't go stale the same way again.

**Search moved into `.epg-player-details`** as its last child, pushed toward the bottom via
`margin-top: auto` (classic flex "push to end") rather than costing a row of its own above
the player row. Required restoring `align-items: stretch` on `.epg-player-row` (round 3 had
set `flex-start` so the hamburger button wouldn't stretch to the dock's height — moved that
opt-out to `align-self: flex-start` on `.epg-menu-col` specifically instead) so the details
column actually stretches to match the dock's height, giving the search input's
`margin-top: auto` real space to push into.

**Real bug #1 — a false-positive auto-refresh on nearly every page load.** The round-1
"auto-refresh when the guide is stale" effect depended on `[bounds, status]`, but `status`
resolving does NOT mean `bounds` has too (`refreshStatus()` fetches bounds as a separate,
later async call). The effect was firing once with `status` resolved but `bounds` still
`null` — read as `bounds?.maxStopMs == null` → "out of runway" → an unconditional forced
refresh, confirmed directly in the server's own logs (a `[epg] refresh started force=true`
line on almost every test run). Fixed by explicitly waiting for a real bounds fetch to
resolve before judging staleness, except for the one legitimate case (guide truly never
refreshed, `status.lastRefreshMs === null`) where bounds will never arrive on its own.

**Real bug #2 — the actual root cause of a resulting HTTP 431, and probably older than this
session.** With "All categories" selected (4,518 real live channels — a provider list far
bigger than the EPG's own ~1,974 *known* channels), the programs-fetch effect built a single
request with ~4,500 channel ids and it exceeded the server's request-header size limit.
Root-caused via direct DOM measurement (`getComputedStyle`) rather than guessing: `.epg-scroll`
was rendering at ~235,000px tall — its own virtualized content's *full* height — instead of
being capped to the viewport with internal scrolling, because (a) `.epg-scroll` never had
`min-height: 0` (a flex item's `min-height` defaults to `auto`, which refuses to shrink below
its own content's intrinsic size no matter what `flex: 1` + `overflow: auto` say — content
here being `RULER_H + rowVirtualizer.getTotalSize()`, an explicitly huge height), and (b)
even after fixing that, `#root` used `min-height: 100svh` rather than `height: 100svh` — a
*minimum*, not a cap, so the whole flex-fill chain below it had nothing definite to size
against and every ancestor (`<body>` included) silently grew to match content instead of
capping at the viewport. Both fixed. This almost certainly predates today — every earlier
round's own verification screenshots were viewport-clipped (`fullPage: false`), which looks
visually identical whether the page is really 800px tall or secretly 235,000px tall with only
the top of it in frame — a real gap in how this session verified layout changes, not just a
one-off miss. Added a defensive cap in the programs-fetch effect too (skip if the apparent
visible range exceeds 200 rows — no real viewport shows anywhere near that many at once) as
cheap insurance against the same failure mode recurring for a different root cause later.

Verified: 5 consecutive fresh page loads with zero HTTP errors (previously reproducible on
most loads with "All categories" selected); a single program-fetch request now carries ~20
ids (the real visible-row count) instead of ~4,500; the full ancestor chain's computed
heights confirmed bounded and correct via direct DOM inspection (`#root`/`body` = viewport
height, `.epg-scroll` = viewport height minus the player row, not the content's full
234,972px); a non-Guide page (Movies) confirmed to still scroll normally at the body level
when its own content exceeds the viewport, unaffected by the `#root` height change. Both
packages typecheck and lint clean, no console errors.

## Guide UI polish, round 5 (2026-08-01)

Small but real cross-platform bug, found from a real desktop (ganymede) screenshot: EPG grid
cells were clipping the second line (start–end time) on desktop while rendering fine on the
tablet. Root cause: neither `.epg-block-title` nor `.epg-block-time` set an explicit
`line-height`, so both inherited the root's `145%` (tuned for body paragraph text, not a
dense two-line grid cell) — at `ROW_H`'s available content height (~38px after padding/insets),
that added up to almost exactly the space available, a razor-thin margin that happened to
render under budget on the tablet's font metrics but tipped over on desktop's. Fixed by
giving both an explicit `line-height: 1.2`, leaving real headroom on both instead of relying
on one platform's rounding to come out ahead. Verified at both the tablet's landscape
dimensions and the exact desktop resolution from the reported screenshot (1202×730, which
resolves the root font-size media query to 18px, not 16px) — both now show the full two-line
cell cleanly.

**Also investigated: phone-width layout is genuinely broken, not just cramped.** Tested via
Playwright at a real phone viewport (412×915, matching a typical Android phone) rather than
guessing. With nothing selected, the preview placeholder + details text + search all stack
above the grid (flex-wrap kicking in at narrow widths), pushing the grid mostly out of view.
With a channel selected, it's worse — preview dock + description + Record button + search
all stack above the grid, consuming the entire viewport height before the grid even starts.
This confirms the user's own hypothesis: the current side-by-side model needs a genuinely
different layout below some phone-width breakpoint, not a tighter version of the same one.
Agreed direction for the next session (not built yet):
- Below the phone breakpoint, no permanent preview dock at all — no placeholder when nothing
  is selected, just the grid immediately.
- Tapping a channel goes straight to fullscreen via the existing Fullscreen API mechanism
  already built for "▶ Watch" (`Player.tsx`'s `handleFullscreen`) — no inline compact dock
  ever appears on phone. Exiting fullscreen returns to the grid with nothing playing inline.
- Program details move into something transient (a bottom sheet, or reusing the `StatsPopover`
  -style on-demand popover pattern) instead of a permanent side column, since there's no spare
  width for a details rail next to the grid at all.
- Open question raised but not yet answered: whether the daughter's iOS device is
  phone-sized or tablet-sized — affects how aggressively this breakpoint needs to kick in.

## Guide UI polish, round 6: phone layout (2026-08-01)

Built the phone layout agreed in round 5. `EpgGuide.tsx` detects phone via a single
`matchMedia("(max-width: 600px), (max-height: 500px)")` — a compound query, not just a width
check, because phone *landscape* (~915×412 on a real device, confirmed via an actual phone
screenshot) is wider than any sane portrait breakpoint but nowhere near tablet-landscape
height (~1280×800); the height half of the query catches phone-landscape without also
catching a sideways tablet. Regression-tested at both tablet orientations (1280×800,
800×1280) via Playwright to confirm neither condition fires there.

Below that breakpoint:
- `.epg-player-row` (dock + details column) is replaced by a slim `.epg-phone-toolbar`
  (just the hamburger + search input) — no placeholder, no permanent preview, no details
  rail. Confirmed via Playwright: page height matches viewport exactly at both 412×915 and
  915×412 (no scroll needed to reach the grid).
- Tapping a channel cell calls the same `startPreview()` as desktop, but on phone this
  mounts `Player` invisibly (`.epg-phone-player-hidden` — `position:fixed`, 1×1px,
  `opacity:0`, kept in normal flow rather than `display:none` since some browsers refuse both
  `requestFullscreen()` and video decoding on a display:none element) with two new Player
  props: `hideChrome` (skip the card/header/video-controls wrapper, render a bare `<video>`)
  and `autoFullscreen` (call `requestFullscreen()` immediately after `video.play()` succeeds,
  inside the same promise chain the original tap started — not a later timer/effect, which is
  what keeps it within the browser's "was this actually triggered by a user gesture" window
  despite the stream-start API call in between). Verified end-to-end against the real sonix
  account: tap → ~2.5–3.5s for the real ffmpeg session to spin up (consistent with this
  provider) → video attaches and plays → fullscreen engages automatically, confirmed via
  `document.fullscreenElement` in a real (headless) browser, not just code review.
- Tapping a program *block* (as opposed to the channel cell) does NOT auto-play — it opens a
  transient bottom sheet (`.epg-phone-sheet`, slides up from the bottom, same title/meta/
  description content as desktop's details column, unclamped since the sheet already scrolls
  internally) with its own explicit "▶ Watch live" / "⏺ Record" / "Close" buttons. Reasoned
  split: tapping the channel itself is an unambiguous "play this now," but tapping a specific
  program block (which might be hours in the future) reading what's on later today shouldn't
  yank the screen into fullscreen — the sheet lets you look without committing to watch.
- New Player prop `onFullscreenExit` fires only on the fullscreen→not-fullscreen transition
  (Esc, swipe-down, back gesture — tracked via a `wasFullscreenRef`, not derivable from state
  alone within the same handler run) — phone wires this to `setPreviewChannel(null)`, fully
  stopping the session and returning to the grid with nothing playing inline, matching round
  5's agreed direction (unlike desktop, phone has no inline resting state to fall back to).
  Verified via Playwright: exiting fullscreen fires the session's `DELETE /stream/:id` request,
  unmounts the hidden Player, and the server's own `/stats` confirms zero active sessions
  afterward — no orphaned ffmpeg process left behind.
- New Player prop `onError` surfaces failures that `hideChrome` would otherwise make
  completely silent (no card, no "Playback failed" text anywhere) — phone shows a brief
  auto-dismissing toast (`.epg-phone-toast`, clears itself after 4s) and drops back to the
  grid.

Known, accepted verification gap: headless Chromium's own Fullscreen API support is not a
perfect stand-in for real mobile Safari/Chrome, particularly iOS Safari's historically
stricter user-activation rules for `requestFullscreen()` after async work. The mechanism
tested clean here (fullscreen reliably engaged even after the ~3s real network round-trip),
and calling `requestFullscreen()` from within the same promise chain as the tap — rather than
a disconnected timer — is exactly the pattern that preserves "transient activation" across
async gaps in every real browser's implementation, but this hasn't been confirmed against an
actual iPhone yet. Still unanswered from round 5: whether the daughter's iPhone 16 needs this
phone breakpoint or the existing tablet layout already fits it — worth checking against her
actual device before assuming this is done for both users.

## Recorder page shortcut + public HTTPS route (2026-08-01)

iptv-recorder gained profiles (Netflix-style, no auth), QR-code client pairing, and a
`GET /config/ui-url` endpoint reporting where its own Settings UI is hosted (env-backed via
`UI_URL`) in a separate, not-yet-committed session. This round wires the first of those into
this app and stands up the HTTPS route the other two (QR scanning specifically) need to
actually work in a browser.

**Server:** `recorderClient.ts` gained `getRecorderUiUrl()`, proxied at
`GET /config/recorder/ui-url` (`server/src/routes/config.ts`), following the exact pattern
already used for `/config/recorder/providers` — this app never re-implements any of
iptv-recorder's own admin surface itself, just links out to it.

**Web:** `Recordings.tsx` gained an "Open Recorder ↗" button next to Refresh. Opens
`window.open("", "_blank")` synchronously at click time, then fills in the real URL once the
fetch resolves (`tab.location.href = url`) — calling `window.open()` only after an already-
awaited fetch is exactly the pattern popup blockers (Safari especially) tend to kill, the same
lesson already applied to `Player.tsx`'s `autoFullscreen` a few rounds ago.

**Infra — `iptv-recorder.pelorus.org`:** added a Caddy route (LAN) and a Cloudflare Tunnel
route (external), deliberately with **no Cloudflare Access** — the first such exception among
~40 routes. This is intentional, not an oversight: iptv-recorder's own profiles are
"no password, no auth boundary" by design (so a family member can pick a profile without any
login), and gating the whole UI behind Cloudflare Access would defeat that on the very first
screen. Full rationale + the two setup gotchas hit standing this up (a stale Caddy-side
Cloudflare DNS-01 token — independent of, and not covered by, the `/etc/homelab` credential
rotation from 2026-07-30 — and Vite's default `allowedHosts` rejection, the first Node/Vite
dev app here placed behind a real hostname instead of a raw LAN IP:port) are documented in the
Holocron: `docker-server/docker-services/iptv-recorder.md` and
`opnsense/caddy-reverse-proxy/routing-inventory-drift-notes.md`.

Verified end-to-end via Playwright: clicking "Open Recorder" opens a new tab that lands on
`https://iptv-recorder.pelorus.org/settings` with the real page title — not just that the
button exists, but that the whole chain (proxy route → iptv-recorder's own `UI_URL` env var →
Caddy → browser) actually resolves to the live app.

Not done this round (deliberately out of scope): actually building a QR-scan-to-configure flow
in this app's own Recorder Connection screen (the daughter's-eventual-camera-access use case
this HTTPS route was really added for) — iptv-recorder can already *generate* a pairing QR
code (`Clients.tsx`), but nothing on this side scans one yet.

## QR pairing (2026-08-01)

Built the scan-to-configure flow flagged as deliberately out of scope above — the whole reason
`iptv-recorder.pelorus.org` needed real HTTPS in the first place (`getUserMedia` requires a
secure context). New `QrScanner.tsx`: `getUserMedia({ video: { facingMode: "environment" } })`
+ a `requestAnimationFrame` loop decoding each frame with `jsQR`, not the native
`BarcodeDetector` API — Safari doesn't implement `BarcodeDetector` at all, including iOS,
which is the actual target device this exists for. `RecorderConnection.tsx`'s not-yet-
configured screen gained a "📷 Scan QR code" button; a successful scan `JSON.parse()`s the
decoded text into `{apiUrl, apiKey}` (iptv-recorder's own `Clients.tsx` documents this exact
payload shape), auto-fills both fields, and auto-submits through the same `PUT /config/recorder`
path the manual form already used (still tests against iptv-recorder before saving anything —
a garbled or wrong scan just surfaces as a normal form error, nothing silent).

**Real, unrelated navigation bug found and fixed while building this — not a QR-scanner bug,
but one that directly blocked reaching the scanner at all.** A first-time user choosing
"recorder mode" from `ProviderSourceChoice` used to stay on whatever tab the Guide start-tab
preference defaulted to (`guide`). With no recorder connection configured yet, `EpgGuide`'s
own providers fetch immediately fails and its error state is a bare `<p>` with no navigation
at all — `App.tsx` only renders its own nav when `tab !== "guide"`, and `EpgGuide`'s early-
return error states don't render its own hamburger either. Genuinely no way to reach Providers
(and therefore the connection form or the QR scanner) short of a precisely-timed manual
refresh. Fixed by having `handleChosen` (`App.tsx`) navigate straight to the `providers` tab
right after the provider-source choice is made — the actual next step regardless of which mode
was picked. The narrower remaining case (leaving mid-setup, reloading later, landing back on
the same dead end) isn't fixed — see Open Questions.

**Verified with a real fake camera, not just code review.** Built a real QR PNG encoding a test
`{apiUrl, apiKey}` payload, converted it to a Y4M video Chromium's `--use-fake-device-for-
media-stream`/`--use-file-for-fake-video-capture` flags can loop as a camera feed, and ran the
actual first-time flow (choice screen → recorder → scan → auto-submit) against an *isolated
scratch instance* (fresh scratch DB, scratch port, no `ENCRYPTION_KEY` overlap) — deliberately
not the real running container, to avoid any risk to the already-working production recorder
connection. Confirmed: `getUserMedia` succeeds, `jsQR` decodes the exact payload from live
video frames, both fields auto-fill correctly, `PUT /config/recorder` fires with the exact
decoded values, and the (deliberately unreachable) fake target correctly surfaces as a normal
connection-test failure rather than anything silent. The real container was confirmed
untouched and still correctly connected immediately after.

## Renamed to Triton (2026-08-01)

`iptv-web-player` renamed to **Triton** — Neptune's largest moon, continuing the naming of
its predecessor, the Windows desktop client Laomedeia. This document, its own commit history,
and every dated section above still say `iptv-web-player` throughout — read as accurate
historical record of what was true when written, not current fact. What changed:

- GitHub repo: `MrGibbage/iptv-web-player` → `MrGibbage/triton` (old name auto-redirects)
- Local directory: `/srv/iptv-web-player` → `/srv/triton`
- Hostname: `iptv-web-player.pelorus.org` → `triton.pelorus.org` — old Caddy + Cloudflare
  Tunnel routes removed outright, not kept as an alias
- `compose.yml` service/container name: `iptv-web-player` → `triton`
- `localSettings.ts`'s localStorage key prefix (`iptv-web-player:` → `triton:`) — a
  deliberate one-time reset of stored UI prefs, not a bug; the file's own header already
  documents these as fine to lose
- Small in-app branding: page title, a trident-emoji favicon, a "🔱 Triton" wordmark next to
  both hamburger menus — deliberately not a hero section or a real logo asset
- `README.md` fully rewritten (it was still a stale pre-code "planning" stub)

Full rationale and verification: Holocron `docker-server/docker-services/triton.md` and
`opnsense/caddy-reverse-proxy/routing-inventory-drift-notes.md`.

## Forget recorder connection (2026-08-01)

Real gap found via testing: on the Providers screen, "Change source" → "Use iptv-recorder's
credentials" doesn't clear the saved connection at all — `recorder_config` is a separate
table from `provider_source_config`, untouched by that choice — so re-choosing recorder mode
always resurrected whatever baseUrl/apiKey was already saved instead of offering a fresh
form. There was no way to actually start over with a different recorder (new base URL, new
API key, or a fresh QR scan) short of editing the database directly.

Fixed with a new `DELETE /config/recorder` (`clearRecorderConfig()` in `db/settings.ts` —
sets `baseUrl`/`apiKeyEncrypted` back to `null`) and a "Forget this recorder" button
(`.button-danger`, matching the visual weight `Recordings.tsx` already uses for destructive
actions — no confirmation dialog, consistent with this app's existing convention of not using
them anywhere else) on `RecorderConnection.tsx`'s connected view. Clicking it clears the
connection and falls straight back to the same "Connect to iptv-recorder" form (manual entry
or QR scan) the first-time setup uses — no detour through the mode-choice screen, since this
only resets the recorder connection itself, not provider-source mode.

Verified end-to-end via Playwright against an isolated scratch instance (fresh DB, scratch
port, deliberately not the real running container) — confirmed the button appears when
connected, clicking it clears the server-side config, and the UI falls back to the fresh form.
Real container confirmed untouched and still connected immediately after deploying.

## Open questions

1. Provider feed size/refresh cost for EPG — worth measuring before accepting a third
   independent XMLTV download as a non-issue long-term.
2. M3U category listing re-parses the whole playlist on every call — no caching yet.
   Revisit if a real M3U playlist proves large enough to make browsing feel slow.
3. Guide, Movies, and TV Shows each fetch their own provider/category/channel list
   independently — worth lifting into shared app-level state once it's clear the
   duplication actually costs something (extra requests, selections falling out of sync).
   (Guide and Live TV used to be the two separate offenders here; they're one screen now —
   see "Guide-centric Live TV.")
4. One ffmpeg process per viewer, not shared per-channel (per the original decision) — if
   multiple household members ever watch the same channel simultaneously, this burns
   multiple of the provider's connection slots for one logical "household is watching X"
   use case. Acceptable for now (matches decision #5's no-active-tracking stance); revisit
   if it proves a real problem in practice.
5. No re-probing — a provider changing a channel's video/audio encoding will silently keep
   using the stale cached decision indefinitely. No manual "re-probe" trigger exists yet.
6. Orphaned playback sessions after the in-memory session map is lost (e.g. a dev-server
   restart) — `stopSession()`/the idle sweep only know about sessions still in that map, so
   a leftover ffmpeg process + `data/hls-sessions/` directory has nothing left to reap it.
   See "Guide-centric Live TV" for the real instances found. The new Diagnostics tab (see
   "Stats for nerds + log download") now at least surfaces the disk-side half of this
   (orphaned directories), so it's visible instead of invisible — but nothing reaps them
   automatically yet, and an orphaned ffmpeg *process* with its directory already cleaned up
   some other way would still be fully invisible. An on-startup reconciliation pass is still
   the real fix; not done yet.
7. **Resolved 2026-08-01.** Reachable at a real hostname —
   `https://iptv-web-player.pelorus.org` via Caddy (LAN) + Cloudflare Tunnel (external),
   deliberately with no Cloudflare Access (this app is the family-facing product itself;
   see the Holocron `docker-server/docker-services/iptv-web-player.md` for the rationale) —
   and, the same day, converted to a real `docker-compose` deployment (single container;
   `server/index.ts` now serves both the API, under an explicit `/api` prefix, and the built
   web client via `@fastify/static`, on one port — no more separate Vite dev server process in
   production). `compose.yml` maps the container back to host port 5173 so the Caddy/Tunnel
   routes needed no changes, bind-mounts the same `server/data` the dev process already used,
   and reuses `server/.env` verbatim (same `ENCRYPTION_KEY` — critical, since a different key
   would've made the already-encrypted recorder connection undecryptable).
   Two real bugs found along the way, both documented in the Holocron page: a pre-existing
   CSS build bug (`series.css` had a stray `*/` inside a comment, invisible until production's
   first real minify pass) and a `localhost`-baseUrl bug specific to containerizing (the
   recorder connection's stored `http://localhost:3300` broke the instant this app moved into
   its own container — fixed via a targeted SQL update of just the plaintext `base_url`
   column, never touching the encrypted API key).
   **Regression found and fixed same day:** channel/VOD picon images are served by the
   provider over plain HTTP, which browsers block as mixed content once the app itself is
   HTTPS. Fixed with a new `GET /api/image-proxy?url=` route (`server/src/routes/
   imageProxy.ts`) that fetches the picon server-side and re-serves the bytes over this app's
   own origin — same shape as the existing playback pipeline, which already never has the
   browser talk to the provider directly. The frontend's `proxiedImageUrl()` helper
   (`web/src/api.ts`) rewrites only `http://` URLs (an already-`https://` picon needs no
   help), used at all four `<img>` call sites (Guide channel logos, VOD/Series posters).
   Because this is the one route here that fetches an arbitrary caller-supplied URL rather
   than something a pre-configured provider itself returned, it also blocks obvious private/
   loopback hostnames (hostname-pattern match, not full DNS-rebind-proof — proportionate to
   this app's actual threat model, not airtight) and requires the upstream response to
   actually be image content. Verified via Playwright against the live HTTPS site: zero
   console/page errors (previously one mixed-content warning per picon), logos visibly
   rendering in a screenshot.
   PWA support (installable to a phone home screen) is technically unblocked now that HTTPS
   exists, but the actual manifest + icons + service worker haven't been built yet (Safari's
   install flow is manual — Share → "Add to Home Screen" — no auto-prompt like Android gets;
   no offline mode or push notifications planned, so iOS's gaps there don't matter).
8. Recording resume/progress — VOD/series titles get watch-progress tracking (see
   "Resume/watch-progress tracking"); completed recordings don't, deliberately deferred
   when built (see "Recording support") since `watchProgress.mediaType` is a real SQLite
   CHECK-constrained enum (`'vod' | 'episode'`) and adding `'recording'` needs a migration,
   not just a type change. Worth doing — a recorded 2-hour game you paused halfway through
   is a real use case — just not bundled into the same change.
9. Recording + live playback sharing a channel — same underlying concern as open question
   #4 (one ffmpeg process per viewer, not shared), now with a second kind of viewer:
   watching a channel live and iptv-recorder recording that same channel are two entirely
   separate connections to the provider (this app's own playback session, plus whatever
   iptv-recorder's worker opens), so a provider connection-slot limit could be hit sooner
   than expected once both features see real use. Not addressed; revisit if it proves a
   real problem in practice, same stance as #4.
10. **Resolved 2026-08-01.** iptv-recorder gained Netflix-profile-style `profiles`
    (no password, no auth boundary — see its own `server/src/routes/profiles.ts`) plus a
    `profileId` column on both `recordings` and `recurring_rules`, in a separate session; this
    round wired that through to here. `recorderClient.ts` gained `listProfiles()` and a
    `profileId` param on both recording-creation functions; a new read-only
    `GET /api/profiles` (`server/src/routes/profiles.ts`) — deliberately read-only, since
    creating/deleting profiles stays iptv-recorder's own job via the "Open Recorder" link
    rather than duplicated here. `localSettings.ts` gained `getCurrentProfileId()`/
    `setCurrentProfileId()` — the same per-browser localStorage trick already used for UI
    prefs, applied to "who's watching this device" instead. A "Who's watching" `<select>` sits
    in both hamburgers (App.tsx's nav, EpgGuide.tsx's combined one) next to Start screen,
    gated on recorder mode. `RecordDialog.tsx` silently attaches whichever profile is
    currently selected (if any) to both one-off and recurring recordings; `Recordings.tsx`
    filters its own list by that same profile when one's selected — no profile selected means
    no filter, identical to before this feature existed, so nothing changes for anyone who
    never picks one.
    Verified end-to-end via Playwright against the real recorder: selected a real profile,
    scheduled a real (6-hours-out, then immediately cancelled) one-off recording, confirmed
    the created recording actually carried the right `profileId`, confirmed a `?profileId=`
    filter both includes the right recording and excludes it under a different id, and
    confirmed `Recordings.tsx`'s own network requests carry the filter correctly.
    **Not done, deliberately:** no UI here to override which profile a specific recording is
    for (it's always whatever's currently selected on this device — matches the Netflix mental
    model of "who's watching," not a per-action picker) and no profile-name display next to
    each recording row in a filtered list (low value once the list is already filtered to one
    profile).
11. **Resolved 2026-08-02 — became a real incident, not just a flagged risk.** The morning
    after "Forget this recorder" shipped, the recorder connection ended up cleared (most
    likely an exploratory or accidental click on that new, confirmation-less button) and the
    Guide start-tab default landed on exactly the dead end this question described:
    `EpgGuide`'s providers-fetch fails immediately with nothing configured, and every
    early-return state (`loading`/`error`/empty) was a bare `<p>` with zero navigation —
    `App.tsx` only shows its own nav when `tab !== "guide"`. Genuinely stuck on a phone, no
    way back to Providers, no way to reconnect.
    Fixed properly this time, not just patched around the one first-choice case: a new
    `EscapeNav` component (trident trigger + nav links only — no category/provider/start-
    screen/profile controls, none of which make sense without real data) now renders in *all
    three* of Guide's early-return states, not just the happy path. Verified directly against
    the live site while it was still in the broken state (not a scratch instance this time —
    nothing left to protect, the real connection was already gone): confirmed the trigger
    appears, and clicking through to Providers successfully reaches the connection form again.
    Also added a `window.confirm()` to "Forget this recorder" — a deliberate, documented
    exception to this app's otherwise-consistent no-confirmation-dialogs convention, added
    specifically because this incident proved the combination (an unrecoverable credential —
    iptv-recorder only ever shows the API key once — plus a real dead end if you're on the
    wrong tab) deserved a pause a cancelled recording doesn't.
    **Not yet done:** actually restoring the user's connection — the API key itself isn't
    recoverable once cleared, so this requires re-entering the base URL/key or rescanning a
    fresh QR code from iptv-recorder's own Clients screen. That's on the user, not fixable in
    code.
