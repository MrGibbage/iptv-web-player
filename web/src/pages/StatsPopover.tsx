import { useEffect, useState } from "react";
import { api, type Stats } from "../api";
import "./diagnostics.css";

type Props = {
  providerId: number;
  channelId: string;
  onClose: () => void;
};

// PLAN.md "Guide UI polish" — the full Diagnostics tab (see Diagnostics.tsx)
// is a separate route, which means navigating to it unmounts whatever
// <Player> is currently running in the Guide's dock, stopping playback —
// exactly backwards for a screen whose whole point is "tell me about what's
// playing right now." This is a small, non-navigating popover instead:
// rendered as a sibling of the still-mounted, still-playing <Player>, so
// opening/closing it never touches playback. Deliberately trimmed compared
// to the full page (just the matching session + a one-line orphan count,
// not the full sessions table or a log download) — "small dialog" per the
// request, with a pointer to the full page for anything deeper.
const POLL_MS = 3000;

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function StatsPopover({ providerId, channelId, onClose }: Props) {
  const [stats, setStats] = useState<Stats | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    function poll() {
      api
        .get<Stats>("/stats")
        .then((s) => {
          if (!cancelled) setStats(s);
        })
        .catch(() => {
          if (!cancelled) setStats("error");
        });
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [providerId, channelId]);

  const current = stats !== "loading" && stats !== "error" ? stats.sessions.find((s) => s.kind === "live" && s.providerId === providerId && s.mediaId === channelId) : undefined;

  return (
    <div className="stats-popover">
      <div className="page-header">
        <strong>Stream stats</strong>
        <button type="button" className="button-link" onClick={onClose}>
          Close
        </button>
      </div>

      {stats === "loading" && <p className="muted">Loading…</p>}
      {stats === "error" && <p className="error">Could not reach /stats.</p>}
      {stats !== "loading" && stats !== "error" && (
        <>
          {current ? (
            <table className="diag-table">
              <tbody>
                <tr>
                  <td>Status</td>
                  <td>{current.status}</td>
                </tr>
                <tr>
                  <td>PID</td>
                  <td>{current.pid ?? "—"}</td>
                </tr>
                <tr>
                  <td>Age</td>
                  <td>{formatDuration(current.ageSecs)}</td>
                </tr>
                <tr>
                  <td>Video</td>
                  <td>{current.videoPassthrough ? "copy" : "transcode"}</td>
                </tr>
                <tr>
                  <td>Audio</td>
                  <td>{current.audioPassthrough ? "copy" : "transcode"}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="muted">Not tracked yet — still starting?</p>
          )}
          <p className="muted" style={{ marginTop: 10, fontSize: "0.78rem" }}>
            Server: {formatBytes(stats.rssBytes)} RSS · {stats.sessions.length} active session(s) · {stats.orphanedSessionDirs.length} orphaned dir(s). See the Diagnostics tab for the
            full picture (this will stop playback here).
          </p>
        </>
      )}
    </div>
  );
}
