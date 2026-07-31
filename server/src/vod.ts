import { getEffectiveProviderConnection } from "./providerSource.js";
import { getVodCategories, getVodStreams, getVodInfo, buildVodStreamUrl } from "./worker/xtreamVod.js";

// PLAN.md "VOD browsing" — Xtream-only, matching Laomedeia's own scope
// (its PRD lists "provider formats other than Xtream Codes" as a v1
// non-goal for VOD/Series specifically — M3U playlists have no VOD/Series
// concept of their own, just a flat live-channel-shaped list, so there's
// nothing to unify here the way Live TV unifies Xtream categories and M3U
// group-titles).

export class VodNotSupportedError extends Error {
  constructor() {
    super("VOD is only supported for Xtream providers");
    this.name = "VodNotSupportedError";
  }
}

export type VodCategory = {
  categoryId: string;
  categoryName: string;
};

export type VodStream = {
  streamId: number;
  name: string;
  streamIcon: string | null;
  categoryId: string;
  containerExtension: string;
  rating: number | null;
  added: string | null;
};

export type VodInfo = {
  plot: string | null;
  cast: string | null;
  director: string | null;
  genre: string | null;
  releaseDate: string | null;
  duration: string | null;
  rating: number | null;
  containerExtension: string;
};

async function requireXtream(providerId: number) {
  const connection = await getEffectiveProviderConnection(providerId);
  if (connection.type !== "xtream") {
    throw new VodNotSupportedError();
  }
  return connection;
}

export async function listVodCategories(providerId: number): Promise<VodCategory[]> {
  const connection = await requireXtream(providerId);
  return getVodCategories(connection);
}

// categoryId omitted lazy-loads the full library — Laomedeia's own
// "search all" scope does the same thing, deliberately only on demand
// (a real account's full VOD library can run in the tens of thousands of
// titles — see its PLAN.md note on ~19,285 VOD titles fetching in a
// couple seconds; still real cost not worth paying by default).
export async function listVodStreams(providerId: number, categoryId?: string): Promise<VodStream[]> {
  const connection = await requireXtream(providerId);
  const streams = await getVodStreams(connection, categoryId);
  return streams.map((s) => ({
    streamId: s.streamId,
    name: s.name,
    streamIcon: s.streamIcon || null,
    categoryId: s.categoryId,
    containerExtension: s.containerExtension,
    rating: s.rating,
    added: s.added,
  }));
}

export async function getVodDetails(providerId: number, vodId: number): Promise<VodInfo | null> {
  const connection = await requireXtream(providerId);
  return getVodInfo(connection, vodId);
}

// containerExtension is passed in (from whatever list/detail call the
// caller already made) rather than re-fetched here — same reasoning as
// Laomedeia's own buildVodStreamUrl call site, which already has the
// extension on hand from the browsed VodStream and doesn't re-request it.
export async function resolveVodStreamUrl(providerId: number, vodId: number, containerExtension: string): Promise<string> {
  const connection = await requireXtream(providerId);
  return buildVodStreamUrl(connection, vodId, containerExtension);
}
