import type { XtreamConnection } from "../recorderClient.js";

// Ported from Laomedeia (electron/xtream.ts) — the Live-channel subset only
// (get_live_categories/get_live_streams). Account validation is already
// covered by ../worker/xtreamAuth.ts's checkXtreamAuth; VOD/Series are a
// separate future feature, not ported here.

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

export interface XtreamLiveCategory {
  categoryId: string;
  categoryName: string;
}

export interface XtreamLiveStream {
  streamId: number;
  num: number;
  name: string;
  streamIcon: string;
  categoryId: string;
  epgChannelId: string | null;
}

export async function getLiveCategories(connection: XtreamConnection): Promise<XtreamLiveCategory[]> {
  const raw = await fetchJson(playerApiUrl(connection, { action: "get_live_categories" }));
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    categoryId: String(entry.category_id),
    categoryName: String(entry.category_name),
  }));
}

export async function getLiveStreams(connection: XtreamConnection, categoryId?: string): Promise<XtreamLiveStream[]> {
  const params: Record<string, string> = { action: "get_live_streams" };
  if (categoryId) params.category_id = categoryId;
  const raw = await fetchJson(playerApiUrl(connection, params));
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    streamId: Number(entry.stream_id),
    num: Number(entry.num ?? 0),
    name: String(entry.name ?? ""),
    streamIcon: String(entry.stream_icon ?? ""),
    categoryId: String(entry.category_id ?? ""),
    epgChannelId: entry.epg_channel_id != null ? String(entry.epg_channel_id) : null,
  }));
}

export function buildLiveStreamUrl(connection: XtreamConnection, streamId: number, extension = "ts"): string {
  const base = normalizeBaseUrl(connection.baseUrl);
  return `${base}/live/${connection.username}/${connection.password}/${streamId}.${extension}`;
}
