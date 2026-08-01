import { and, eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { watchProgress } from "./db/schema.js";
import { providerCacheKey } from "./providerSource.js";

// Resume/watch-progress tracking (PLAN.md Open Questions — the one
// Laomedeia feature both the VOD and Series ports explicitly dropped for
// not having a progress store yet). No per-provider-type branching here:
// unlike vod.ts/series.ts, a resume position is just a number keyed by
// whatever mediaId the caller already resolved a stream for — it doesn't
// care whether that id came from Xtream VOD or a series episode.

export type MediaType = "vod" | "episode";

export type Progress = {
  positionSecs: number;
  durationSecs: number | null;
};

// Mirrors Laomedeia's own progress-store rules: a position too close to the
// start isn't worth resuming (the user barely started watching), and one
// too close to the end means they effectively finished it. Without this,
// every close (even at 0:03 or at 99%) would leave a stale row behind
// forever — nothing else ever clears one.
const MIN_RESUMABLE_SECS = 10;
const END_THRESHOLD_SECS = 30;

function isNearStartOrEnd(positionSecs: number, durationSecs: number | null): boolean {
  if (positionSecs < MIN_RESUMABLE_SECS) return true;
  if (durationSecs != null && positionSecs > durationSecs - END_THRESHOLD_SECS) return true;
  return false;
}

export function getProgress(providerId: number, mediaType: MediaType, mediaId: string): Progress | null {
  const providerKey = providerCacheKey(providerId);
  const [row] = db
    .select()
    .from(watchProgress)
    .where(and(eq(watchProgress.providerKey, providerKey), eq(watchProgress.mediaType, mediaType), eq(watchProgress.mediaId, mediaId)))
    .all();
  if (!row) return null;
  return { positionSecs: row.positionSecs, durationSecs: row.durationSecs };
}

export function saveProgress(providerId: number, mediaType: MediaType, mediaId: string, positionSecs: number, durationSecs: number | null): void {
  const providerKey = providerCacheKey(providerId);
  const key = and(eq(watchProgress.providerKey, providerKey), eq(watchProgress.mediaType, mediaType), eq(watchProgress.mediaId, mediaId));

  if (isNearStartOrEnd(positionSecs, durationSecs)) {
    db.delete(watchProgress).where(key).run();
    return;
  }

  const rounded = Math.round(positionSecs);
  const roundedDuration = durationSecs != null ? Math.round(durationSecs) : null;
  db.insert(watchProgress)
    .values({ providerKey, mediaType, mediaId, positionSecs: rounded, durationSecs: roundedDuration })
    .onConflictDoUpdate({
      target: [watchProgress.providerKey, watchProgress.mediaType, watchProgress.mediaId],
      set: { positionSecs: rounded, durationSecs: roundedDuration, updatedAt: new Date() },
    })
    .run();
}
