import { decrypt } from "./crypto.js";
import { getRecorderConfig } from "./db/settings.js";

// Thin HTTP client for iptv-recorder's API, used only when
// providerSourceConfig.mode = 'recorder' (see ../db/schema.ts). Mirrors
// iptv-scheduler's own recorderClient.ts — this service is a client of
// iptv-recorder the same as any other, through its normal public surface
// only. Trimmed to the two endpoints provider browsing needs; no
// recordings-related methods, since this app doesn't touch recordings (v1
// decision — see PLAN.md).

export type RecorderProvider = {
  id: number;
  name: string;
  type: "xtream" | "m3u";
  baseUrl: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

// Mirrors iptv-recorder's own ProviderConnection (server/src/worker/
// providerShape.ts) and iptv-scheduler's copy of the same type.
export type XtreamConnection = { type: "xtream"; baseUrl: string; username: string; password: string };
export type M3uConnection = { type: "m3u"; playlistUrl: string; epgUrl: string | null };
export type ProviderConnection = XtreamConnection | M3uConnection;

// Thrown instead of making a request when no recorder connection has been
// configured yet. Distinguishes "not configured" from an actual
// connectivity failure so callers can surface the right message.
export class RecorderNotConfiguredError extends Error {
  constructor() {
    super("no recorder connection configured (see PUT /config/recorder)");
    this.name = "RecorderNotConfiguredError";
  }
}

function requireConnection(): { baseUrl: string; apiKey: string } {
  const config = getRecorderConfig();
  if (!config.baseUrl || !config.apiKeyEncrypted) {
    throw new RecorderNotConfiguredError();
  }
  return { baseUrl: config.baseUrl, apiKey: decrypt(config.apiKeyEncrypted) };
}

async function rawFetch(baseUrl: string, apiKey: string, path: string): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`iptv-recorder ${path} returned ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function recorderFetch(path: string): Promise<Response> {
  const { baseUrl, apiKey } = requireConnection();
  return rawFetch(baseUrl, apiKey, path);
}

export async function listProviders(): Promise<RecorderProvider[]> {
  const response = await recorderFetch("/providers");
  return response.json() as Promise<RecorderProvider[]>;
}

// Raw, unredacted credentials — iptv-recorder's own PLAN.md documents this
// as the one deliberate exception to "credentials redacted in every
// response", for exactly this kind of trusted sibling-service use. Never
// log or persist the result; use it for the immediate call and discard it.
export async function getProviderConnection(providerId: number): Promise<ProviderConnection> {
  const response = await recorderFetch(`/providers/${providerId}/connection`);
  return response.json() as Promise<ProviderConnection>;
}

// Validates a candidate baseUrl/apiKey pair against iptv-recorder before
// it's ever saved (PUT /config/recorder) — same "test before persisting"
// principle used throughout these services. GET /providers is the cheapest
// authenticated call available: a 2xx confirms both that baseUrl is
// reachable and that apiKey is accepted.
export async function testRecorderConnection(candidate: {
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await rawFetch(candidate.baseUrl, candidate.apiKey, "/providers");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
