import type { XtreamConnection } from "../recorderClient.js";

// Ported from Laomedeia (electron/xtream.ts) — the Series subset only
// (get_series_categories/get_series/get_series_info). Mirrors
// ./xtreamVod.ts's structure exactly, including its own copy of the
// player_api.php request helpers.

const REQUEST_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Server URL must start with http:// or https://");
  }
  return trimmed;
}

function playerApiUrl(connection: XtreamConnection, params: Record<string, string> = {}): string {
  const base = normalizeBaseUrl(connection.baseUrl);
  const url = new URL(`${base}/player_api.php`);
  url.searchParams.set("username", connection.username);
  url.searchParams.set("password", connection.password);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Server responded with HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function toRating(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface XtreamSeriesCategory {
  categoryId: string;
  categoryName: string;
}

export interface XtreamSeriesListItem {
  seriesId: number;
  name: string;
  cover: string;
  categoryId: string;
  rating: number | null;
}

export interface XtreamSeriesEpisode {
  id: string;
  episodeNum: number;
  title: string;
  containerExtension: string;
  season: number;
  plot: string | null;
  duration: string | null;
}

export interface XtreamSeriesSeason {
  seasonNumber: number;
  name: string | null;
  episodes: XtreamSeriesEpisode[];
}

export interface XtreamSeriesInfo {
  name: string;
  cover: string;
  plot: string | null;
  cast: string | null;
  director: string | null;
  genre: string | null;
  releaseDate: string | null;
  rating: number | null;
  seasons: XtreamSeriesSeason[];
}

export async function getSeriesCategories(connection: XtreamConnection): Promise<XtreamSeriesCategory[]> {
  const raw = await fetchJson(playerApiUrl(connection, { action: "get_series_categories" }));
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    categoryId: String(entry.category_id),
    categoryName: String(entry.category_name),
  }));
}

export async function getSeriesList(connection: XtreamConnection, categoryId?: string): Promise<XtreamSeriesListItem[]> {
  const params: Record<string, string> = { action: "get_series" };
  if (categoryId) params.category_id = categoryId;
  const raw = await fetchJson(playerApiUrl(connection, params));
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    seriesId: Number(entry.series_id),
    name: String(entry.name ?? ""),
    cover: String(entry.cover ?? ""),
    categoryId: String(entry.category_id ?? ""),
    rating: toRating(entry.rating_5based ?? entry.rating),
  }));
}

export async function getSeriesInfo(connection: XtreamConnection, seriesId: number): Promise<XtreamSeriesInfo | null> {
  const raw = await fetchJson(playerApiUrl(connection, { action: "get_series_info", series_id: String(seriesId) }));
  const obj = raw as {
    info?: Record<string, unknown>;
    episodes?: Record<string, Array<Record<string, unknown>>>;
    seasons?: Array<Record<string, unknown>>;
  } | null;
  if (!obj?.info) return null;
  const info = obj.info;

  const seasonNames = new Map<number, string | null>();
  for (const s of obj.seasons ?? []) {
    const num = Number(s.season_number);
    if (Number.isFinite(num)) seasonNames.set(num, s.name != null ? String(s.name) : null);
  }

  const episodesBySeason = obj.episodes ?? {};
  const seasons: XtreamSeriesSeason[] = Object.keys(episodesBySeason)
    .map((key) => Number(key))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((seasonNumber) => ({
      seasonNumber,
      name: seasonNames.get(seasonNumber) ?? null,
      episodes: (episodesBySeason[String(seasonNumber)] ?? []).map((ep) => {
        const epInfo = (ep.info ?? {}) as Record<string, unknown>;
        return {
          id: String(ep.id),
          episodeNum: Number(ep.episode_num ?? 0),
          title: String(ep.title ?? `Episode ${ep.episode_num ?? ""}`),
          containerExtension: String(ep.container_extension ?? "mp4"),
          season: seasonNumber,
          plot: epInfo.plot != null ? String(epInfo.plot) : null,
          duration: epInfo.duration != null ? String(epInfo.duration) : null,
        };
      }),
    }));

  return {
    name: String(info.name ?? ""),
    cover: String(info.cover ?? ""),
    plot: (info.plot ?? info.description) != null ? String(info.plot ?? info.description) : null,
    cast: (info.cast ?? info.actors) != null ? String(info.cast ?? info.actors) : null,
    director: info.director != null ? String(info.director) : null,
    genre: info.genre != null ? String(info.genre) : null,
    releaseDate: (info.releaseDate ?? info.release_date) != null ? String(info.releaseDate ?? info.release_date) : null,
    rating: toRating(info.rating_5based ?? info.rating),
    seasons,
  };
}

export function buildSeriesStreamUrl(connection: XtreamConnection, episodeId: string, extension: string): string {
  const base = normalizeBaseUrl(connection.baseUrl);
  return `${base}/series/${connection.username}/${connection.password}/${episodeId}.${extension}`;
}
