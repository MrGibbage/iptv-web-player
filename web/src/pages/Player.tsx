import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { api } from "../api";

type Props = {
  providerId: number;
  mediaId: string;
  channelName: string;
  onClose: () => void;
  // "Compact" is the small preview-dock rendering used by the Live TV
  // preview-then-promote flow (PLAN.md "Live TV preview") — smaller size, no
  // native controls, and (if previewTimeoutSecs is set) an auto-close timer.
  // Deliberately just a rendering/behavior toggle on the SAME Player
  // instance rather than two different components: the parent flips
  // `compact` to false to promote without changing providerId/mediaId/kind,
  // so React reuses this instance and the running session (and its ffmpeg
  // process) is never torn down and restarted.
  compact?: boolean;
  previewTimeoutSecs?: number | null;
  onPromote?: () => void;
} & (
  | { kind: "live" }
  | { kind: "vod"; containerExtension: string; startPositionSecs?: number }
  | { kind: "series"; containerExtension: string; startPositionSecs?: number }
);

type PlayerState = "starting" | "playing" | "error";

// PLAN.md "Playback architecture" — starts an HLS session server-side
// (spawns ffmpeg, see ../../server side), then plays the resulting
// playlist with hls.js (needed for Chrome/Firefox; Safari could use native
// <video> but hls.js works everywhere, so one code path is simpler).
// Always stops its session on unmount — a closed/navigated-away player
// shouldn't leave ffmpeg running — the server's own idle sweep is a
// backstop for the cases this can't catch (hard refresh, tab close).
//
// Real incident (PLAN.md "Playback logging"): StrictMode's dev-only
// mount->cleanup->mount double-invoke meant every "Watch" click actually
// started TWO sessions for the same channel a few hundred ms apart — two
// simultaneous connections to the provider for the same channel/account,
// even though the throwaway one was torn down almost immediately after.
// Both real incidents this surfaced show the survivor getting cut by the
// provider (clean ffmpeg exit, code 0, no error) ~10s later — consistent
// enough across two unrelated channels that it looks like cause and
// effect, not coincidence. Fix: START_DEBOUNCE_MS delays the actual POST
// just long enough for StrictMode's synchronous double-invoke to finish
// and mark the throwaway instance cancelled before it sends a request —
// this is the common case, but not an absolute guarantee: real testing
// later (Live TV preview) saw a throwaway instance occasionally still get
// far enough to open (and immediately close) a real connection under
// genuine network latency. Harmless when it happens (cleaned up within the
// same click, dev-only via StrictMode, never occurs in a production
// build), just not airtight.
const START_DEBOUNCE_MS = 50;

// hls.js defaults to backBufferLength: Infinity — for a live stream, it
// never discards old buffered video, so the browser tab's memory grows for
// as long as you keep watching (~490 KB/s observed against real sonix
// channels, so ~5GB over a 3-hour game). Browsers do enforce their own MSE
// quota and will force eviction regardless once a tab gets big enough, but
// relying on that is unpredictable (device/browser-dependent, invisible
// until it happens). Bounding it ourselves keeps the same live-rewind
// feature (confirmed working — see PLAN.md "Playback implementation") but
// with predictable, capped memory use instead.
const BACK_BUFFER_SECONDS = 600;

// Progress is saved this often while playing, plus once more immediately on
// close/unmount (PLAN.md "Resume/watch-progress tracking") — matches
// Laomedeia's own interval, frequent enough that closing mid-episode never
// loses more than ~20s of real progress. Only meaningful for vod/series —
// there's no "resume a live channel" concept.
const PROGRESS_SAVE_INTERVAL_MS = 20_000;

export function Player(props: Props) {
  const { providerId, mediaId, channelName, onClose, kind, compact, previewTimeoutSecs, onPromote } = props;
  const containerExtension = props.kind === "vod" || props.kind === "series" ? props.containerExtension : undefined;
  const startPositionSecs = (props.kind === "vod" || props.kind === "series") && props.startPositionSecs ? props.startPositionSecs : undefined;
  const mediaType = kind === "vod" ? "vod" : kind === "series" ? "episode" : null;
  // The server, not this component, does the actual resume seek (real bug
  // found in testing — see hlsSession.ts's StartSessionOptions.startOffsetSecs
  // comment for why a client-side video.currentTime seek doesn't work here).
  // The returned stream already begins at startPositionSecs, so this
  // component just plays it from 0 like any other session — but every
  // position it reports back for progress-saving has to add this offset
  // back in, or a resumed session would keep reporting positions relative to
  // the resume point instead of the real file, silently rewinding the saved
  // progress every time.
  const resumeOffsetSecs = startPositionSecs ?? 0;
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [state, setState] = useState<PlayerState>("starting");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setState("starting");
    setError(undefined);
    sessionIdRef.current = null;
    // Captured once up front (rather than read via videoRef.current inside
    // the cleanup below) — the <video> element itself is stable for this
    // component's whole lifetime, but reading a ref's .current directly
    // inside a cleanup function is a real footgun in general (it may have
    // already changed by the time cleanup runs), so it's captured into a
    // plain variable instead.
    const video = videoRef.current;

    const startTimer = setTimeout(() => {
      if (cancelled) return;
      const startCall =
        kind === "live"
          ? api.post<{ sessionId: string; playlistUrl: string }>(`/providers/${providerId}/live/stream`, { channelId: mediaId })
          : kind === "vod"
            ? api.post<{ sessionId: string; playlistUrl: string }>(`/providers/${providerId}/vod/stream`, {
                vodId: Number(mediaId),
                containerExtension,
                startPositionSecs,
              })
            : api.post<{ sessionId: string; playlistUrl: string }>(`/providers/${providerId}/series/stream`, {
                episodeId: mediaId,
                containerExtension,
                startPositionSecs,
              });
      startCall
        .then(({ sessionId: id, playlistUrl }) => {
          if (cancelled) {
            api.delete(`/stream/${id}`).catch(() => {});
            return;
          }
          sessionIdRef.current = id;
          if (!video) return;
          const fullUrl = `/api${playlistUrl}`;

          if (Hls.isSupported()) {
            const hls = new Hls({ backBufferLength: BACK_BUFFER_SECONDS });
            hlsRef.current = hls;
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                console.error("HLS fatal error", data.details, data.error?.message);
                setState("error");
                setError(data.details);
              }
            });
            hls.loadSource(fullUrl);
            hls.attachMedia(video);
          } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = fullUrl;
          } else {
            setState("error");
            setError("This browser can't play HLS video.");
            return;
          }
          video.play().catch(() => {});
          setState("playing");
        })
        .catch((err) => {
          if (cancelled) return;
          setState("error");
          setError(err instanceof Error ? err.message : String(err));
        });
    }, START_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      // Final progress save on close/unmount, on top of the periodic one
      // below — otherwise closing mid-episode could lose up to
      // PROGRESS_SAVE_INTERVAL_MS of real progress. currentTime > 0 also
      // guards the StrictMode throwaway mount's cleanup (dev-only
      // mount->cleanup->mount — see the comment above START_DEBOUNCE_MS):
      // that instance never gets past the debounce, so its video element
      // never loaded anything and currentTime is still 0.
      if (mediaType && video && video.currentTime > 0) {
        api
          .put(`/providers/${providerId}/progress/${mediaType}/${mediaId}`, {
            positionSecs: resumeOffsetSecs + video.currentTime,
            durationSecs: Number.isFinite(video.duration) ? resumeOffsetSecs + video.duration : null,
          })
          .catch(() => {});
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (sessionIdRef.current) {
        api.delete(`/stream/${sessionIdRef.current}`).catch(() => {});
      }
    };
  }, [providerId, mediaId, kind, containerExtension, mediaType, startPositionSecs, resumeOffsetSecs]);

  // Polls the session's own status so a server-side failure (ffmpeg died,
  // provider dropped the stream) surfaces its real reason here — found via
  // a real incident that otherwise the only signal is hls.js noticing
  // indirectly, several segments later, through failed fetches, with a
  // generic client-side error and no idea why the server actually stopped.
  useEffect(() => {
    if (state !== "playing") return;
    const interval = setInterval(() => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      api
        .get<{ status: "starting" | "running" | "error"; error: string | null }>(`/stream/${sessionId}/status`)
        .then((s) => {
          if (s.status === "error") {
            setState("error");
            setError(s.error ?? "stream stopped unexpectedly");
          }
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [state]);

  // Periodic resume-position save while actually playing — the on-close
  // save above only covers the end of the session, not a long-running one
  // that never closes cleanly (crash, hard refresh). No-op for live (no
  // mediaType).
  useEffect(() => {
    if (state !== "playing" || !mediaType) return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.currentTime <= 0) return;
      api
        .put(`/providers/${providerId}/progress/${mediaType}/${mediaId}`, {
          positionSecs: resumeOffsetSecs + video.currentTime,
          durationSecs: Number.isFinite(video.duration) ? resumeOffsetSecs + video.duration : null,
        })
        .catch(() => {});
    }, PROGRESS_SAVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state, providerId, mediaId, mediaType, resumeOffsetSecs]);

  // Auto-close for an unpromoted preview (PLAN.md "Live TV preview") — a
  // user setting (see /config/player), not a hardcoded constant, since
  // there's no single right answer for how long a preview should linger
  // before it's considered abandoned. Purely client-driven: promoting just
  // flips `compact` to false, which re-runs this effect and (since the
  // guard below then returns early) clears the pending timer without
  // touching the running session at all. If the tab/browser dies before
  // this fires, the server's own existing idle sweep is the same backstop
  // it already is for every other session — no server-side concept of
  // "preview" needed on top of that.
  useEffect(() => {
    if (!compact || !previewTimeoutSecs) return;
    const timer = setTimeout(() => onClose(), previewTimeoutSecs * 1000);
    return () => clearTimeout(timer);
  }, [compact, previewTimeoutSecs, onClose]);

  return (
    <div className={compact ? "card player-compact" : "card"} style={{ maxWidth: compact ? 360 : 720 }}>
      <div className="page-header">
        <h2>{channelName}</h2>
        <div className="player-header-actions">
          {compact && onPromote && (
            <button type="button" onClick={onPromote}>
              ▶ Watch
            </button>
          )}
          <button type="button" className="button-link" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {state === "starting" && <p>Starting stream…</p>}
      {state === "error" && <p className="error">Playback failed: {error}</p>}
      <video
        ref={videoRef}
        controls={!compact}
        onClick={compact ? onPromote : undefined}
        style={{ width: "100%", display: state === "error" ? "none" : "block", background: "#000", cursor: compact ? "pointer" : undefined }}
      />
    </div>
  );
}
