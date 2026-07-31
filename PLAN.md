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

**Still open:** the specific codec-probe/allowlist logic that decides passthrough vs.
transcode hasn't been designed yet — see Open Questions.

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

## Open questions

1. Codec-probe/allowlist design for the hybrid playback path — what determines
   passthrough-legal vs. needs-transcode, and where does that check happen (on first
   channel tune? cached per provider/channel?). Not designed yet.
2. Provider feed size/refresh cost for EPG — worth measuring before accepting a third
   independent XMLTV download as a non-issue long-term.
3. M3U category listing re-parses the whole playlist on every call — no caching yet.
   Revisit if a real M3U playlist proves large enough to make browsing feel slow.
4. Guide and Live TV each fetch their own provider/category/channel list independently —
   worth lifting into shared app-level state once enough pages exist to make the
   duplication actually cost something (extra requests, selections falling out of sync).
