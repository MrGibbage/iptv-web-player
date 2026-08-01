import { useEffect, useState } from "react";
import { api, type Stats } from "../api";
import "./diagnostics.css";

// "Stats for nerds" (PLAN.md) — same idea as Laomedeia's own diagnostics
// view: a plain, no-frills read-only look at what the server is actually
// doing right now, mainly useful for "why is this slow/broken" rather than
// everyday use. Polls GET /stats rather than pushing over a socket — this
// app has no other real-time UI yet, and a few seconds of staleness on a
// debug panel doesn't matter.
const POLL_MS = 5000;

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function Diagnostics() {
  const [stats, setStats] = useState<Stats | "loading" | "error">("loading");

  useEffect(() => {
    function poll() {
      api
        .get<Stats>("/stats")
        .then(setStats)
        .catch(() => setStats("error"));
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="page">
      <div className="page-header">
        <h2>Diagnostics</h2>
        <a className="button-link" href="/api/logs/download" download>
          Download logs
        </a>
      </div>
      <p className="muted">Server internals — active playback sessions, process health, and a raw log file to send along when something breaks.</p>

      {stats === "loading" && <p>Loading…</p>}
      {stats === "error" && <p className="error">Could not reach /stats.</p>}
      {stats !== "loading" && stats !== "error" && (
        <>
          <div className="diag-summary">
            <div>
              <span className="diag-summary-label">Server uptime</span>
              <span>{formatDuration(stats.uptimeSecs)}</span>
            </div>
            <div>
              <span className="diag-summary-label">Memory (RSS)</span>
              <span>{formatBytes(stats.rssBytes)}</span>
            </div>
            <div>
              <span className="diag-summary-label">Heap used</span>
              <span>{formatBytes(stats.heapUsedBytes)}</span>
            </div>
          </div>

          <h3>Active playback sessions ({stats.sessions.length})</h3>
          {stats.sessions.length === 0 ? (
            <p className="muted">Nothing playing right now.</p>
          ) : (
            <table className="diag-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Media</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>PID</th>
                  <th>Age</th>
                  <th>Idle</th>
                  <th>Video</th>
                  <th>Audio</th>
                </tr>
              </thead>
              <tbody>
                {stats.sessions.map((s) => (
                  <tr key={s.id} className={s.status === "error" ? "diag-row-error" : undefined}>
                    <td>{s.providerId}</td>
                    <td title={s.mediaId}>{s.mediaId}</td>
                    <td>{s.kind}</td>
                    <td title={s.error ?? undefined}>{s.status}</td>
                    <td>{s.pid ?? "—"}</td>
                    <td>{formatDuration(s.ageSecs)}</td>
                    <td>{formatDuration(s.idleSecs)}</td>
                    <td>{s.videoPassthrough ? "copy" : "transcode"}</td>
                    <td>{s.audioPassthrough ? "copy" : "transcode"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Orphaned session directories ({stats.orphanedSessionDirs.length})</h3>
          {stats.orphanedSessionDirs.length === 0 ? (
            <p className="muted">None — every directory on disk has a tracked session.</p>
          ) : (
            <>
              <p className="muted">
                Left behind on disk with no session tracking them anymore — usually from a dev-server restart while something was playing (see PLAN.md, open question). The ffmpeg
                process behind one of these may still be running even though nothing here can see it; if playback seems to be eating CPU/bandwidth with nothing obviously watching,
                this is why.
              </p>
              <ul>
                {stats.orphanedSessionDirs.map((dir) => (
                  <li key={dir} className="diag-orphan">
                    {dir}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
