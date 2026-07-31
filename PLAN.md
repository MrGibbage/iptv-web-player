# Plan

## Status

Planning phase — no code yet. This document captures the architecture decisions worked
through before implementation starts, and the open questions still unresolved. Living
document, same role PLAN.md plays in iptv-recorder and iptv-scheduler.

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

## Decision points

### 1. Playback architecture — the hard part, not yet decided

Laomedeia plays raw Xtream `.ts` URLs directly into libmpv, backed by a hand-built
event-driven watchdog (stall detection, GPU-decode wedge detection, software-decode
fallback) built after real production incidents. None of that exists in a browser, and
browsers can't play raw MPEG-TS directly. Three options discussed:

1. **Client-side JS remux** (mpegts.js-style) — fetch the raw stream, demux TS→fMP4
   in-browser, feed MSE. No server transcode cost, lowest latency — but every provider
   stream problem hits the browser directly with no server-side buffer to smooth over
   reconnects, and codec support is whatever the browser's decoder does.
2. **Server-side remux to HLS** — ffmpeg repackages/transcodes into segmented `.m3u8`
   for `<video>`/hls.js. Most compatible across devices (TVs, phones, Safari), adds CPU
   load and segment-buffering latency, centralizes error recovery server-side instead of
   reimplementing a watchdog in every browser tab.
3. **Hybrid** — passthrough remux when the source is already browser-legal, transcode
   fallback otherwise. Most efficient, most complex to decide "when."

Leaning toward server-side remux (2 or 3): iptv-recorder's
`server/src/worker/ffmpegRemux.ts` already proved against a real channel that
`-c copy -f mpegts` is required — fragmented MP4 broke on ADTS-framed AAC and MP2/AC-3
audio (see that file's header comment). That lesson transfers directly. The *code*
doesn't: recorder's remux is a fixed-duration capture-to-file for one job; this needs a
continuous process serving possibly multiple simultaneous viewers, a different lifecycle
entirely. New code, informed by an already-paid-for lesson.

**Open question:** client remux, server remux, or hybrid — not decided.

### 2. Relationship to iptv-recorder / iptv-scheduler

New sibling service. Own database, own provider-credential store with mirrored crypto
(matching the pattern iptv-scheduler already used against iptv-recorder). No runtime
dependency on either service being up just to watch live TV.

**Open question:** should this eventually surface iptv-recorder's completed-recordings
library in its own UI, so recordings and live/VOD/series all live in one browsing
experience? If yes, that's a legitimate HTTP-client relationship to recorder (same shape
as scheduler's `recorderClient.ts`) — but not needed for v1.

### 3. EPG ingestion

iptv-scheduler already ingests EPG data (`server/src/epg/*`), but its `epg_programs`
table is shaped for rule-matching (flat table, no FTS5, no time/channel-bounded
virtualization queries) — not for rendering a fast searchable guide grid. Default: port
Laomedeia's own EPG module wholesale rather than force scheduler's differently-shaped
table into a guide-rendering role it wasn't built for.

**Open question:** is a third independent XMLTV download from the provider (Laomedeia
desktop, scheduler, now this) acceptable, or does the provider's feed size/refresh cost
make that wasteful enough to justify pulling raw programme data from scheduler over HTTP
instead, materializing only the FTS5/guide-shaped cache locally? Not decided — depends on
real feed size/cost we haven't measured.

### 4. Credentials & multi-user model

Laomedeia stores credentials per-machine, single user (explicit non-goal: multi-profile).
A web service centralizes credentials by nature.

**Open question:** LAN-only, single-user, no auth — or real multi-user auth because
household members will hit one shared backend holding provider credentials? Not decided;
changes scope non-trivially if multi-user.

### 5. Concurrent viewers vs. provider connection limits

Xtream's account-info response already reports `active_cons`/`max_connections`. A single
desktop app instance could never exceed this; multiple browser tabs/devices against one
shared backend now can.

**Open question:** does the backend need to actively track/enforce/display current
stream count against the provider's max, or is surfacing the provider's own rejection
error enough? Not decided.

### 6. Deployment & remote access

docker-server is the natural home — matches the existing m3u-editor-stack and the
documented Hetzner/FRP pattern for `m3u.pelorus.org` (LAN via OPNsense Caddy, remote via
Hetzner Caddy + FRP, deliberately bypassing Cloudflare's CDN/Tunnel for video traffic).

**Open question:** is remote (away-from-home) access in scope for v1, or LAN-only until
the core product works? If remote, the same Hetzner/FRP precedent likely applies rather
than routing video through Cloudflare.

### 7. VOD/Series container formats

Xtream VOD/Series entries carry whatever `container_extension` the provider used — mp4
plays natively in `<video>`, mkv and others don't. Whichever playback architecture is
chosen under #1 needs to cover VOD/Series, not just Live.

## Not yet decided — stack/scaffolding

No code exists yet; this document precedes scaffolding. iptv-recorder and iptv-scheduler
both use Fastify + Drizzle + SQLite server-side and Vite + React on the web side —
following that convention is the default assumption but hasn't been explicitly confirmed
for this project.

## Open questions summary

1. Playback: client-side remux, server-side remux/HLS, or hybrid?
2. Should completed recordings from iptv-recorder be surfaced here, and on what timeline?
3. Independent EPG ingestion (port Laomedeia's module) vs. client of iptv-scheduler's raw
   EPG data — depends on real provider feed size/cost, not yet measured.
4. Single-user/LAN-only vs. multi-user/household auth?
5. Does the provider's max-connections limit need active tracking, or is surfacing the
   provider's own error sufficient?
6. Is remote (away-from-home) access in scope for v1?
7. Confirm Fastify + Drizzle + SQLite + Vite/React as the stack, matching recorder/scheduler.
