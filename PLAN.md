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

iptv-recorder's completed-recordings library is **not surfaced in v1.** Revisit later via
an HTTP-client relationship to recorder (same shape as scheduler's `recorderClient.ts`)
once the core Live/EPG/VOD/Series viewer is solid.

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

## Open questions

1. Provider feed size/refresh cost for EPG — worth measuring before accepting a third
   independent XMLTV download as a non-issue long-term.
2. M3U category listing re-parses the whole playlist on every call — no caching yet.
   Revisit if a real M3U playlist proves large enough to make browsing feel slow.
3. Guide and Live TV each fetch their own provider/category/channel list independently —
   worth lifting into shared app-level state once enough pages exist to make the
   duplication actually cost something (extra requests, selections falling out of sync).
4. One ffmpeg process per viewer, not shared per-channel (per the original decision) — if
   multiple household members ever watch the same channel simultaneously, this burns
   multiple of the provider's connection slots for one logical "household is watching X"
   use case. Acceptable for now (matches decision #5's no-active-tracking stance); revisit
   if it proves a real problem in practice.
5. No re-probing — a provider changing a channel's video/audio encoding will silently keep
   using the stale cached decision indefinitely. No manual "re-probe" trigger exists yet.
