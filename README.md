# iptv-web-player

A web-based IPTV player for Xtream-compatible providers — Live TV, a fast searchable EPG,
and Movies/Series browsing with resume, reachable from any browser instead of an installed
per-machine client.

**Status: planning — no code yet.** See [PLAN.md](PLAN.md) for the architecture decisions
under discussion and the open questions still blocking a first line of code.

## Related projects

- **Laomedeia** — the Windows desktop client (`~/projects/iptv` on ganymede) this aims to
  bring to the web. Its PRD.md/SDD.md/PLAN.md describe the product this should match.
- **iptv-recorder** (`/srv/iptv-recorder`) — scheduled DVR capture to disk. Sibling service,
  not a dependency of this one.
- **iptv-scheduler** (`/srv/iptv-scheduler`) — EPG ingestion + recording-rule matching.
  Sibling service, not a dependency of this one.
