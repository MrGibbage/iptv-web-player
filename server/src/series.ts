import { getEffectiveProviderConnection } from "./providerSource.js";
import { getSeriesCategories, getSeriesList, getSeriesInfo, buildSeriesStreamUrl } from "./worker/xtreamSeries.js";

// PLAN.md "Series (TV Shows)" — Xtream-only, same reasoning as vod.ts:
// M3U playlists have no series concept of their own to unify against.

export class SeriesNotSupportedError extends Error {
  constructor() {
    super("Series is only supported for Xtream providers");
    this.name = "SeriesNotSupportedError";
  }
}

export type SeriesCategory = {
  categoryId: string;
  categoryName: string;
};

export type SeriesListItem = {
  seriesId: number;
  name: string;
  cover: string | null;
  categoryId: string;
  rating: number | null;
};

export type SeriesEpisode = {
  id: string;
  episodeNum: number;
  title: string;
  containerExtension: string;
  season: number;
  plot: string | null;
  duration: string | null;
};

export type SeriesSeason = {
  seasonNumber: number;
  name: string | null;
  episodes: SeriesEpisode[];
};

export type SeriesInfo = {
  name: string;
  cover: string | null;
  plot: string | null;
  cast: string | null;
  director: string | null;
  genre: string | null;
  releaseDate: string | null;
  rating: number | null;
  seasons: SeriesSeason[];
};

async function requireXtream(providerId: number) {
  const connection = await getEffectiveProviderConnection(providerId);
  if (connection.type !== "xtream") {
    throw new SeriesNotSupportedError();
  }
  return connection;
}

export async function listSeriesCategories(providerId: number): Promise<SeriesCategory[]> {
  const connection = await requireXtream(providerId);
  return getSeriesCategories(connection);
}

// categoryId omitted lazy-loads the full library — same "search all" scope
// reasoning as vod.ts.
export async function listSeriesList(providerId: number, categoryId?: string): Promise<SeriesListItem[]> {
  const connection = await requireXtream(providerId);
  const list = await getSeriesList(connection, categoryId);
  return list.map((s) => ({ seriesId: s.seriesId, name: s.name, cover: s.cover || null, categoryId: s.categoryId, rating: s.rating }));
}

export async function getSeriesDetails(providerId: number, seriesId: number): Promise<SeriesInfo | null> {
  const connection = await requireXtream(providerId);
  const info = await getSeriesInfo(connection, seriesId);
  if (!info) return null;
  return { ...info, cover: info.cover || null };
}

// containerExtension is passed in from the already-fetched episode data —
// same reasoning as vod.ts's resolveVodStreamUrl.
export async function resolveEpisodeStreamUrl(providerId: number, episodeId: string, containerExtension: string): Promise<string> {
  const connection = await requireXtream(providerId);
  return buildSeriesStreamUrl(connection, episodeId, containerExtension);
}
