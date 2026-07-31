import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { api } from "../api";

type Props = {
  providerId: number;
  channelId: string;
  channelName: string;
  onClose: () => void;
};

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
// and mark the throwaway instance cancelled *before* it ever sends a
// request, so only the surviving instance opens a real connection at all.
const START_DEBOUNCE_MS = 50;

export function Player({ providerId, channelId, channelName, onClose }: Props) {
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

    const startTimer = setTimeout(() => {
      if (cancelled) return;
      api
        .post<{ sessionId: string; playlistUrl: string }>(`/providers/${providerId}/live/stream`, { channelId })
        .then(({ sessionId: id, playlistUrl }) => {
          if (cancelled) {
            api.delete(`/stream/${id}`).catch(() => {});
            return;
          }
          sessionIdRef.current = id;
          const video = videoRef.current;
          if (!video) return;
          const fullUrl = `/api${playlistUrl}`;

          if (Hls.isSupported()) {
            const hls = new Hls();
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
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (sessionIdRef.current) {
        api.delete(`/stream/${sessionIdRef.current}`).catch(() => {});
      }
    };
  }, [providerId, channelId]);

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

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <h2>{channelName}</h2>
        <button type="button" className="button-link" onClick={onClose}>
          Close
        </button>
      </div>
      {state === "starting" && <p>Starting stream…</p>}
      {state === "error" && <p className="error">Playback failed: {error}</p>}
      <video ref={videoRef} controls style={{ width: "100%", display: state === "error" ? "none" : "block", background: "#000" }} />
    </div>
  );
}
