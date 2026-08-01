// Thin fetch wrapper for iptv-web-player's own API (proxied at /api by Vite
// in dev, see vite.config.ts). No auth header — this app has no auth at all
// (single-user, LAN-only decision, see PLAN.md).

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set a JSON Content-Type when there's actually a body — Fastify's
  // JSON parser 400s on an empty body if the header claims JSON regardless.
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `request failed (${res.status})`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string): Promise<T> => request<T>(path),
  post: <T,>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: (path: string): Promise<void> => request<void>(path, { method: "DELETE" }),
};

// PLAN.md "Docker deployment" — provider picons are plain http://, which
// browsers now block as mixed content since this app itself is HTTPS.
// Routes through the server's own /image-proxy (imageProxy.ts) instead,
// which fetches the bytes server-side and re-serves them over this app's
// own origin. Only rewrites http:// specifically — an already-https://
// picon (or a relative/local one) needs no help and shouldn't pay the
// extra hop.
export function proxiedImageUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith("http://")) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

export type ProviderSourceConfig = {
  mode: "recorder" | "local" | null;
  updatedAt: string;
};

export type RecorderConfig = {
  baseUrl: string | null;
  configured: boolean;
  updatedAt: string;
};

export type ProviderType = "xtream" | "m3u";

export type Provider = {
  id: number;
  name: string;
  type: ProviderType;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProviderInput = {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  username?: string;
  password?: string;
  playlistUrl?: string;
  epgUrl?: string;
};

export type AuthCheckResult = {
  ok: boolean;
  error?: string;
  checkedAt: string;
};

export type EffectiveProvider = {
  id: number;
  name: string;
  type: ProviderType;
  baseUrl: string | null;
  enabled: boolean;
};

export type LiveCategory = {
  categoryId: string;
  categoryName: string;
};

export type LiveChannel = {
  channelId: string;
  name: string;
  streamIcon: string | null;
  categoryId: string | null;
  epgChannelId: string | null;
};

export type EpgStatus = {
  state: "idle" | "refreshing" | "error";
  phase: "download" | "ingest" | null;
  lastRefreshMs: number | null;
  channelCount: number;
  programCount: number;
  error: string | null;
};

export type EpgProgram = {
  id: number;
  channelId: string;
  startMs: number;
  stopMs: number;
  title: string;
  description: string;
};

export type EpgSearchResult = EpgProgram & {
  channelName: string;
};

export type EpgBounds = {
  minStartMs: number | null;
  maxStopMs: number | null;
};

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

export type Progress = {
  positionSecs: number;
  durationSecs: number | null;
};

export type SessionStats = {
  id: string;
  providerId: number;
  mediaId: string;
  kind: "live" | "vod";
  status: "starting" | "running" | "error";
  error: string | null;
  pid: number | null;
  ageSecs: number;
  idleSecs: number;
  videoPassthrough: boolean;
  audioPassthrough: boolean;
};

export type Stats = {
  uptimeSecs: number;
  rssBytes: number;
  heapUsedBytes: number;
  sessions: SessionStats[];
  orphanedSessionDirs: string[];
};

export type RecordingStatus = "scheduled" | "recording" | "completed" | "failed" | "cancelled";

export type Recording = {
  id: number;
  providerId: number;
  channelId: string;
  recurringRuleId: number | null;
  startTime: string;
  endTime: string;
  status: RecordingStatus;
  filePath: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  projected?: boolean;
};

export type ProjectedOccurrence = {
  recurringRuleId: number;
  providerId: number;
  channelId: string;
  startTime: string;
  endTime: string;
  status: "scheduled";
  projected: true;
};

export function isProjectedOccurrence(row: Recording | ProjectedOccurrence): row is ProjectedOccurrence {
  return row.projected === true && !("id" in row);
}

export type RecurringRule = {
  id: number;
  providerId: number;
  channelId: string;
  daysOfWeek: number;
  startMinuteOfDay: number;
  durationMinutes: number;
  endDate: string | null;
  maxOccurrences: number | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecurrencePattern = {
  daysOfWeek: number;
  startMinuteOfDay: number;
  durationMinutes: number;
  endDate?: string;
  maxOccurrences?: number;
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
