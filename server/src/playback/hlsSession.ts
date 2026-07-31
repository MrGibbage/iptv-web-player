import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveLiveStreamUrl } from "../liveChannels.js";
import { providerCacheKey } from "../providerSource.js";
import { getCodecDecision } from "./codecProbe.js";
import { log } from "../logger.js";

// PLAN.md "Playback architecture" — one ffmpeg process per playback
// session (not shared across viewers, see PLAN.md for why), always
// outputting HLS with MPEG-TS segments so recorder's own -c copy -f mpegts
// lesson keeps applying regardless of audio codec. Video is copied when the
// codec probe says it's browser-playable (see ./codecProbe.ts), re-encoded
// otherwise. This is live viewing, not DVR: a sliding segment window, no
// retention.
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
const PLAYLIST_SIZE = 6;
const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_MS = 300;
const IDLE_TIMEOUT_MS = 30_000;
const SWEEP_INTERVAL_MS = 10_000;
const STDERR_TAIL_MAX_CHARS = 4000;

type SessionStatus = "starting" | "running" | "error";

interface Session {
  id: string;
  providerId: number;
  channelId: string;
  dir: string;
  process: ChildProcess;
  lastAccessMs: number;
  status: SessionStatus;
  error: string | null;
  stderrTail: string;
}

const sessions = new Map<string, Session>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlaybackStartError extends Error {}

export async function startSession(providerId: number, channelId: string): Promise<{ sessionId: string; playlistUrl: string }> {
  const providerKey = providerCacheKey(providerId);
  const streamUrl = await resolveLiveStreamUrl(providerId, channelId);
  const { videoPassthrough, audioPassthrough } = await getCodecDecision(providerKey, channelId, streamUrl);

  const sessionId = crypto.randomUUID();
  const dir = path.join(HLS_DATA_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  log("playback", `${sessionId}: starting provider=${providerId} channel=${channelId} video=${videoPassthrough ? "copy" : "transcode"} audio=${audioPassthrough ? "copy" : "transcode"}`);

  const args = [
    // Input-side reconnect options — real IPTV streams hiccup; without
    // these a transient drop kills the whole session instead of resuming.
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
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
    String(PLAYLIST_SIZE),
    "-hls_flags",
    "delete_segments+append_list",
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
    channelId,
    dir,
    process: proc,
    lastAccessMs: Date.now(),
    status: "starting",
    error: null,
    stderrTail: "",
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
  session.process.once("exit", () => clearTimeout(killTimer));
  rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

export function stopAllSessions(): void {
  for (const id of [...sessions.keys()]) stopSession(id, "server shutting down");
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
