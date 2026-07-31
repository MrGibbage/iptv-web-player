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
