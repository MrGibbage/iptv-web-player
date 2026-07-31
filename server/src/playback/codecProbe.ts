import { spawn } from "node:child_process";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { channelCodecCache } from "../db/schema.js";

// PLAN.md "Playback architecture" — recorder's own lesson (-c copy -f
// mpegts avoids bitstream-filter failures for ADTS AAC/MP2/AC-3) solves
// TS-*container* compatibility, not browser *decoder* compatibility —
// browsers can't play raw MPEG-TS via <video> at all (see ./hlsSession.ts,
// always HLS with TS segments), and separately, a browser's MSE decoder
// only accepts a narrow codec/profile subset regardless of what the
// container itself can hold.
const PROBE_TIMEOUT_MS = 10_000;

// Conservative on purpose: only h264 is guaranteed broadly decodable across
// browsers/devices on the LAN without hardware/vendor-specific support.
// HEVC works in some browsers (notably Safari) but not reliably enough to
// default to passthrough — expand this set later if it proves fine in
// practice for this household's actual devices.
const PASSTHROUGH_VIDEO_CODECS = new Set(["h264"]);

// No audio-passthrough allowlist — tried one keyed on ffprobe's `profile`
// string (AAC-LC/HE-AAC "safe", Main/SSR "not") and found it unreliable via
// real testing against the sonix account: a real channel's ffprobe profile
// read "HE-AAC" (its deeper analysis detected an SBR extension), but the
// *raw ADTS header's* base object type — what hls.js's demuxer actually
// reads to build the browser-facing codec string — still signaled Main
// (mp4a.40.1), which browsers' MSE reject outright. HE-AAC streams are
// commonly a Main/LC base layer plus an SBR extension; ffprobe's semantic
// label doesn't reliably reflect what ends up in a copied ADTS header.
// Audio transcoding is cheap (unlike video), so there's no real cost to
// just always re-encoding to a known-good AAC-LC instead of chasing
// increasingly subtle codec-detection edge cases.

export class ProbeFailedError extends Error {}

interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
}

async function ffprobeStreams(url: string): Promise<ProbedStream[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile", "-of", "json", url]);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new ProbeFailedError("ffprobe timed out"));
    }, PROBE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new ProbeFailedError(`could not run ffprobe: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new ProbeFailedError(`ffprobe exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { streams?: ProbedStream[] };
        resolve(parsed.streams ?? []);
      } catch (err) {
        reject(new ProbeFailedError(`could not parse ffprobe output: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

export type CodecDecision = {
  videoCodec: string;
  videoPassthrough: boolean;
  audioCodec: string | null;
  audioProfile: string | null;
  audioPassthrough: boolean;
};

// Cache-first: a channel's codec rarely changes, so repeat tunes shouldn't
// pay ffprobe's cost (and the network round-trip to the provider) again.
export async function getCodecDecision(providerKey: string, channelId: string, streamUrl: string): Promise<CodecDecision> {
  const [cached] = db
    .select()
    .from(channelCodecCache)
    .where(and(eq(channelCodecCache.providerKey, providerKey), eq(channelCodecCache.channelId, channelId)))
    .all();
  if (cached) {
    return {
      videoCodec: cached.videoCodec,
      videoPassthrough: cached.videoPassthrough,
      audioCodec: cached.audioCodec,
      audioProfile: cached.audioProfile,
      audioPassthrough: cached.audioPassthrough,
    };
  }

  const streams = await ffprobeStreams(streamUrl);
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video?.codec_name) {
    throw new ProbeFailedError("ffprobe returned no video stream");
  }

  const videoCodec = video.codec_name;
  const videoPassthrough = PASSTHROUGH_VIDEO_CODECS.has(videoCodec);
  const audioCodec = audio?.codec_name ?? null;
  const audioProfile = audio?.profile ?? null;
  // Always transcode audio when one exists — see the file header comment
  // for why an allowlist here proved unreliable. "No audio stream at all"
  // is the only case treated as passthrough: there's nothing for -c:a to
  // do either way.
  const audioPassthrough = !audio;

  const decision: CodecDecision = { videoCodec, videoPassthrough, audioCodec, audioProfile, audioPassthrough };

  db.insert(channelCodecCache)
    .values({ providerKey, channelId, ...decision })
    .onConflictDoUpdate({
      target: [channelCodecCache.providerKey, channelCodecCache.channelId],
      set: { ...decision, probedAt: new Date() },
    })
    .run();

  return decision;
}
