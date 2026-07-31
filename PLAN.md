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
  feature needing its own branch on `providerSourceConfig.mode`. Not consumed by anything
  yet — no other feature exists to consume it.
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

## Open questions

1. Codec-probe/allowlist design for the hybrid playback path — what determines
   passthrough-legal vs. needs-transcode, and where does that check happen (on first
   channel tune? cached per provider/channel?). Not designed yet.
2. Provider feed size/refresh cost for EPG — worth measuring before accepting a third
   independent XMLTV download as a non-issue long-term.
