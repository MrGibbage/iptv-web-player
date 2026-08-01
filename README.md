# 🔱 Triton

A self-hosted, browser-based IPTV player for Xtream-compatible providers — a live TV guide
with a fast searchable EPG, Movies/Series browsing with resume, and (via a connected
`iptv-recorder` instance) DVR scheduling and playback. No install, no per-device client —
open a URL in any browser.

Named after Neptune's largest moon, continuing the naming of its predecessor,
**Laomedeia** — the Windows desktop client this project set out to bring to the web, and now
effectively supersedes for browser-based use.

See [PLAN.md](PLAN.md) for the full design history: architecture decisions, real bugs found
and fixed along the way, and the running list of open questions.

## Stack

- **Server**: Fastify + Drizzle ORM + better-sqlite3 (TypeScript, ESM)
- **Web**: Vite + React + TypeScript
- **Playback**: ffmpeg spawned per viewer, remuxing live/VOD/series/recording sources into
  browser-playable HLS (`hls.js` client-side)
- pnpm workspace (`server/`, `web/`)

## Running it

Docker Compose is the supported deployment (`compose.yml`, repo root):

```sh
docker compose up -d --build
```

The server serves both the API (under `/api`) and the built web client on a single port —
see `server/src/index.ts`. `server/.env` needs `ENCRYPTION_KEY` (a base64-encoded 32-byte
value, used to encrypt provider/recorder credentials at rest) before first run.

For local development, run the two workspace packages separately instead:

```sh
pnpm --filter server dev   # tsx watch, port 4300
pnpm --filter web dev      # vite, port 5173, proxies /api to the server above
```

## Credentials model

On first run, choose where provider credentials come from:

- **Recorder mode** — point at an existing `iptv-recorder` instance (base URL + API key, or
  scan the QR code it generates when creating a new client) and reuse whatever providers are
  already configured there. Also unlocks DVR scheduling/playback, since recording is entirely
  `iptv-recorder`'s own job.
- **Local mode** — enter Xtream/M3U provider details directly; no recording capability.

## Related projects

- **iptv-recorder** (`/srv/iptv-recorder`) — scheduled DVR capture to disk, plus the
  Netflix-style `profiles` concept this app's "Who's watching" picker reads from. Sibling
  service, optional dependency.
- **iptv-scheduler** (`/srv/iptv-scheduler`) — EPG ingestion + recording-rule matching. Older
  sibling service, not a dependency of this one.
- **Laomedeia** — the original Windows desktop client this project grew out of.
