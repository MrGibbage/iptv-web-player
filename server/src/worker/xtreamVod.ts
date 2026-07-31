import type { XtreamConnection } from "../recorderClient.js";

// Ported from Laomedeia (electron/xtream.ts) — the VOD subset only
// (get_vod_categories/get_vod_streams/get_vod_info). Mirrors
// ./xtreamLive.ts's structure exactly, including its own copy of the
// player_api.php request helpers — small enough that sharing them across
// files isn't worth the indirection.

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

export interface XtreamVodCategory {
  categoryId: string;
  categoryName: string;
}

export interface XtreamVodStream {
  streamId: number;
  name: string;
  streamIcon: string;
  categoryId: string;
  containerExtension: string;
  rating: number | null;
  added: string | null;
}

export interface XtreamVodInfo {
  plot: string | null;
  cast: string | null;
  director: string | null;
  genre: string | null;
  releaseDate: string | null;
  duration: string | null;
  rating: number | null;
  containerExtension: string;
}

export async function getVodCategories(connection: XtreamConnection): Promise<XtreamVodCategory[]> {
  const raw = await fetchJson(playerApiUrl(connection, { action: "get_vod_categories" }));
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    categoryId: String(entry.category_id),
    categoryName: String(entry.category_name),
  }));
}

export async function getVodStreams(connection: XtreamConnection, categoryId?: string): Promise<XtreamVodStream[]> {
  const params: Record<string, string> = { action: "get_vod_streams" };
  if (categoryId) params.category_id = categoryId;
  const raw = await fetchJson(playerApiUrl(connection, params));
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    streamId: Number(entry.stream_id),
    name: String(entry.name ?? ""),
    streamIcon: String(entry.stream_icon ?? ""),
    categoryId: String(entry.category_id ?? ""),
    containerExtension: String(entry.container_extension ?? "mp4"),
    rating: toRating(entry.rating_5based ?? entry.rating),
    added: entry.added != null ? String(entry.added) : null,
  }));
}

export async function getVodInfo(connection: XtreamConnection, vodId: number): Promise<XtreamVodInfo | null> {
  const raw = await fetchJson(playerApiUrl(connection, { action: "get_vod_info", vod_id: String(vodId) }));
  const obj = raw as { info?: Record<string, unknown>; movie_data?: Record<string, unknown> } | null;
  if (!obj?.info) return null;
  const info = obj.info;
  const movieData = obj.movie_data ?? {};
  return {
    plot: (info.plot ?? info.description) != null ? String(info.plot ?? info.description) : null,
    cast: (info.cast ?? info.actors) != null ? String(info.cast ?? info.actors) : null,
    director: info.director != null ? String(info.director) : null,
    genre: info.genre != null ? String(info.genre) : null,
    releaseDate: (info.releasedate ?? info.release_date) != null ? String(info.releasedate ?? info.release_date) : null,
    duration: info.duration != null ? String(info.duration) : null,
    rating: toRating(info.rating),
    containerExtension: String(movieData.container_extension ?? "mp4"),
  };
}

export function buildVodStreamUrl(connection: XtreamConnection, streamId: number, extension: string): string {
  const base = normalizeBaseUrl(connection.baseUrl);
  return `${base}/movie/${connection.username}/${connection.password}/${streamId}.${extension}`;
}
