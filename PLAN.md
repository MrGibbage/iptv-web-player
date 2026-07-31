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

### 2. Relationship to iptv-recorder / iptv-scheduler: sibling, no dependency for v1

New sibling service. Own database, own provider-credential store with mirrored crypto
(matching the pattern iptv-scheduler already used against iptv-recorder). No runtime
dependency on either service being up just to watch live TV.

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
`server/` (Fastify health check, Drizzle client pointed at a placeholder `schema.ts`,
`drizzle.config.ts`), `web/` (Vite + React, dev-server proxy to `/api`, a health-check
ping in `App.tsx`). No routes, no DB tables, no crypto/credential storage yet — those
land with the first real feature, same as both sibling projects did.

## Open questions

1. Codec-probe/allowlist design for the hybrid playback path — what determines
   passthrough-legal vs. needs-transcode, and where does that check happen (on first
   channel tune? cached per provider/channel?). Not designed yet.
2. Provider feed size/refresh cost for EPG — worth measuring before accepting a third
   independent XMLTV download as a non-issue long-term.
