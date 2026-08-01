import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getCodecDecision, headerArgs } from "./codecProbe.js";
import { log } from "../logger.js";

// PLAN.md "Playback architecture" — one ffmpeg process per playback
// session (not shared across viewers, see PLAN.md for why), always
// outputting HLS with MPEG-TS segments so recorder's own -c copy -f mpegts
// lesson keeps applying regardless of audio codec. Video is copied when the
// codec probe says it's browser-playable (see ./codecProbe.ts), re-encoded
// otherwise.
//
// Two session kinds, PLAN.md "VOD playback":
//   - 'live': a sliding segment window, no retention (delete_segments,
//     hls_list_size 6) — this is live viewing, not DVR.
//   - 'vod': the source has a real, finite length. No sliding window
//     (hls_list_size 0 — keep every segment in the manifest), and no
//     delete_segments — ffmpeg naturally appends #EXT-X-ENDLIST once the
//     whole file is processed, at which point hls.js reports the correct
//     total duration instead of the "keeps climbing" live behavior.
// This module doesn't resolve the stream URL itself — the caller (routes/
// playback.ts) does that via ../liveChannels.ts or ../vod.ts depending on
// kind, and passes the resolved URL straight in. Keeps this module
// agnostic to how a URL was resolved, not just to which kind it serves.
//
// No auto-restart on ffmpeg failure — mirrors Laomedeia's own explicit
// decision (PLAN.md/SDD there: "an automatic kill-and-relaunch was tried
// and abandoned... landed instead: a fixed, honest message with no Retry").
// A session that errors surfaces that state via GET /stream/:id/status;
// the user retries by starting a new session (clicking Watch again), same
// as Laomedeia's "Restart Player" button is a manual, one-click action
// rather than a silent automatic one.

const HLS_DATA_DIR = process.env.HLS_DATA_DIR ?? "./data/hls-sessions";
const SEGMENT_DURATION_S = 4;
const LIVE_PLAYLIST_SIZE = 6;
const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_MS = 300;
const IDLE_TIMEOUT_MS = 30_000;
const SWEEP_INTERVAL_MS = 10_000;
const STDERR_TAIL_MAX_CHARS = 4000;

type SessionKind = "live" | "vod";
type SessionStatus = "starting" | "running" | "error";

interface Session {
  id: string;
  providerId: number;
  mediaId: string;
  kind: SessionKind;
  dir: string;
  process: ChildProcess;
  startedAtMs: number;
  lastAccessMs: number;
  status: SessionStatus;
  error: string | null;
  stderrTail: string;
  videoPassthrough: boolean;
  audioPassthrough: boolean;
}

const sessions = new Map<string, Session>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlaybackStartError extends Error {}

export interface StartSessionOptions {
  providerId: number;
  mediaId: string;
  streamUrl: string;
  kind: SessionKind;
  // Cache key for ./codecProbe.ts — providerSource.providerCacheKey() for
  // live channels; VOD titles don't need the recorder-vs-local namespacing
  // (a numeric Xtream vod streamId can't collide with anything else the
  // way channel ids across provider sources could), so routes/vod.ts just
  // passes a plain "vod-<providerId>" prefix instead.
  codecCacheKey: string;
  // Resume support (PLAN.md "Resume/watch-progress tracking") — vod/series
  // only. Real testing found that seeking client-side (hls.js/<video>
  // .currentTime) after the session already started doesn't work: ffmpeg
  // always begins transcoding from position 0, so the HLS playlist it
  // serves in the first second or two only covers the first few seconds of
  // real content — nowhere near a non-trivial resume point yet — and
  // video.currentTime silently clamps down into that tiny available range
  // instead of erroring, so the client can't tell it landed in the wrong
  // place. Passing this straight to ffmpeg as an input-side "-ss" instead
  // means the HLS output IS the resumed stream from the first segment; the
  // client just plays it from 0 like any other session, no client-side seek
  // race to lose.
  startOffsetSecs?: number;
  // Recording playback only (PLAN.md "Recording support") — iptv-recorder's
  // GET /recordings/:id/file requires a Bearer token, unlike a live
  // channel/VOD title's own provider URL which carries its own auth (Xtream
  // username/password in the URL itself, or nothing for a public M3U).
  headers?: Record<string, string>;
}

export async function startSession(opts: StartSessionOptions): Promise<{ sessionId: string; playlistUrl: string }> {
  const { providerId, mediaId, streamUrl, kind, codecCacheKey, startOffsetSecs, headers } = opts;
  const { videoPassthrough, audioPassthrough } = await getCodecDecision(codecCacheKey, mediaId, streamUrl, headers);

  const sessionId = crypto.randomUUID();
  const dir = path.join(HLS_DATA_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  log("playback", `${sessionId}: starting kind=${kind} provider=${providerId} media=${mediaId} video=${videoPassthrough ? "copy" : "transcode"} audio=${audioPassthrough ? "copy" : "transcode"}`);

  const args = [
    // Input-side reconnect options — real IPTV streams hiccup; without
    // these a transient drop kills the whole session instead of resuming.
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    // Placed before -i (input seeking) rather than after — ffmpeg seeks in
    // the demuxer before decoding starts, instead of decoding+discarding
    // from position 0, so a large resume point doesn't cost a slow
    // real-time fast-forward through everything before it.
    ...(startOffsetSecs && startOffsetSecs > 0 ? ["-ss", String(startOffsetSecs)] : []),
    ...headerArgs(headers),
    "-i",
    streamUrl,
    "-c:v",
    videoPassthrough ? "copy" : "libx264",
    ...(videoPassthrough ? [] : ["-preset", "veryfast"]),
    // AAC-LC is the broadly MSE-decodable target when re-encoding audio —
    // see ./codecProbe.ts for why "the TS container accepts it" and "the
    // browser can decode it" turned out to be two different questions.
    "-c:a",
    audioPassthrough ? "copy" : "aac",
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_DURATION_S),
    "-hls_list_size",
    kind === "live" ? String(LIVE_PLAYLIST_SIZE) : "0",
    "-hls_flags",
    kind === "live" ? "delete_segments+append_list" : "append_list",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    path.join(dir, "seg_%05d.ts"),
    path.join(dir, "playlist.m3u8"),
  ];

  const proc = spawn("ffmpeg", args);
  const session: Session = {
    id: sessionId,
    providerId,
    mediaId,
    kind,
    dir,
    process: proc,
    startedAtMs: Date.now(),
    lastAccessMs: Date.now(),
    status: "starting",
    error: null,
    stderrTail: "",
    videoPassthrough,
    audioPassthrough,
  };
  sessions.set(sessionId, session);

  proc.stderr.on("data", (chunk: Buffer) => {
    session.stderrTail = (session.stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_CHARS);
  });
  proc.on("exit", (code) => {
    // A deliberate stopSession() already removed this session from the map
    // and doesn't care about its exit — only mark error if this was
    // unexpected (still the map's current entry for this id).
    if (sessions.get(sessionId) === session && session.status !== "error") {
      session.status = "error";
      session.error = `ffmpeg exited unexpectedly (code ${code})`;
      // The in-memory stderrTail dies with the session at cleanup (idle
      // sweep runs every 10s, 30s timeout) — this is the only place that
      // reason survives past that, which is the whole point: found via a
      // real incident that there was otherwise no way to tell "provider
      // dropped the stream" from "our own process crashed" after the fact.
      log("playback", `${sessionId}: ffmpeg exited unexpectedly code=${code}\n${session.stderrTail || "(no stderr captured)"}`);
    }
  });

  const playlistPath = path.join(dir, "playlist.m3u8");
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (session.status === "error") {
      stopSession(sessionId, "startup failed");
      throw new PlaybackStartError(`ffmpeg failed to start: ${session.stderrTail.slice(-500) || "no output"}`);
    }
    try {
      const content = await readFile(playlistPath, "utf-8");
      if (content.includes(".ts")) {
        session.status = "running";
        session.lastAccessMs = Date.now();
        log("playback", `${sessionId}: started successfully`);
        return { sessionId, playlistUrl: `/stream/${sessionId}/playlist.m3u8` };
      }
    } catch {
      // playlist not written yet
    }
    await sleep(STARTUP_POLL_MS);
  }
  stopSession(sessionId, "startup timed out");
  throw new PlaybackStartError("timed out waiting for the stream to start");
}

export function touchSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.lastAccessMs = Date.now();
  return true;
}

// Only ever reads a filename this module itself generated (playlist.m3u8,
// seg_NNNNN.ts) via the HLS muxer's own manifest — validated anyway since
// it comes from a URL path segment.
const SAFE_FILENAME = /^[a-zA-Z0-9_.-]+$/;

export function getSessionFilePath(sessionId: string, filename: string): string | null {
  const session = sessions.get(sessionId);
  if (!session || !SAFE_FILENAME.test(filename)) return null;
  return path.join(session.dir, filename);
}

export function getSessionStatus(sessionId: string): { status: SessionStatus; error: string | null } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return { status: session.status, error: session.error };
}

const KILL_GRACE_MS = 3_000;

export function stopSession(sessionId: string, reason = "stopped"): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  log("playback", `${sessionId}: ${reason}`);
  session.process.kill("SIGTERM");
  // SIGTERM lets ffmpeg's HLS muxer flush and exit cleanly, which is the
  // common case (observed exiting within ~2-3s against a real provider
  // stream) — but a stuck network read could in principle ignore it
  // indefinitely, and an orphaned ffmpeg process is expensive (still
  // pulling from the provider, not just idling). SIGKILL after a grace
  // period bounds that regardless of what the process is doing.
  const killTimer = setTimeout(() => {
    if (!session.process.killed) session.process.kill("SIGKILL");
  }, KILL_GRACE_MS);
  // rm() only runs once ffmpeg has actually exited, not fired alongside
  // SIGTERM — a real bug found in testing: ffmpeg keeps writing new segment
  // files for as long as it takes to flush (the same few seconds SIGTERM
  // above accounts for), so an rm() started immediately could race it and
  // leave the directory non-empty (a new segment written after the sweep),
  // which is exactly what was found on disk (session dirs from finished
  // playback never actually cleaned up).
  session.process.once("exit", () => {
    clearTimeout(killTimer);
    rm(session.dir, { recursive: true, force: true }).catch(() => {});
  });
}

export function stopAllSessions(): void {
  for (const id of [...sessions.keys()]) stopSession(id, "server shutting down");
}

export interface SessionStats {
  id: string;
  providerId: number;
  mediaId: string;
  kind: SessionKind;
  status: SessionStatus;
  error: string | null;
  pid: number | undefined;
  ageSecs: number;
  idleSecs: number;
  videoPassthrough: boolean;
  audioPassthrough: boolean;
}

export function listSessionStats(): SessionStats[] {
  const now = Date.now();
  return [...sessions.values()].map((s) => ({
    id: s.id,
    providerId: s.providerId,
    mediaId: s.mediaId,
    kind: s.kind,
    status: s.status,
    error: s.error,
    pid: s.process.pid,
    ageSecs: Math.round((now - s.startedAtMs) / 1000),
    idleSecs: Math.round((now - s.lastAccessMs) / 1000),
    videoPassthrough: s.videoPassthrough,
    audioPassthrough: s.audioPassthrough,
  }));
}

// Directories left behind under HLS_DATA_DIR that no tracked session claims
// — PLAN.md open question "orphaned playback sessions when the in-memory
// session map is lost" (e.g. a dev-server restart while a session was
// running: the ffmpeg child keeps running as a real OS process, and its
// segment directory is never cleaned up by stopSession()'s own exit-handler
// since nothing calls it anymore). This is the disk-side half of that gap —
// it can't see the orphaned ffmpeg process itself (this process has no
// record of its pid once the map entry is gone), but a leftover directory
// still on disk is a reliable proxy for "something wasn't cleaned up",
// visible without needing to shell out to `ps`.
export async function listOrphanedSessionDirs(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(HLS_DATA_DIR);
  } catch {
    return [];
  }
  return entries.filter((name) => !sessions.has(name));
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startHlsSweep(): void {
  sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastAccessMs > IDLE_TIMEOUT_MS) {
        stopSession(id, "idle timeout");
      }
    }
  }, SWEEP_INTERVAL_MS);
}

export function stopHlsSweep(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
