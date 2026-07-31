import { PROVIDER_STATUS_CHECK_TIMEOUT_MS } from "../config.js";
import type { providers } from "../db/schema.js";
import { resolveProviderConnection } from "./providerShape.js";

export type AuthCheckResult = { ok: true } | { ok: false; error: string };

// Standard Xtream Codes "player API" auth/info endpoint:
//   {baseUrl}/player_api.php?username=...&password=...
// Common Xtream panel convention, not verified against every possible
// provider shape — adjust here if a real provider differs. A valid response
// is JSON with user_info.auth === 1; invalid credentials typically come back
// as auth: 0 rather than an HTTP error, so a 200 alone doesn't mean the
// credentials are good.
//
// Takes raw credentials, not a stored provider row, so it backs both a live
// status check on an existing local provider (decrypts first, see
// checkProviderAuth below) and POST /providers/test, which tests credentials
// before they're ever saved/encrypted.
export async function checkXtreamAuth(credentials: {
  baseUrl: string;
  username: string;
  password: string;
}): Promise<AuthCheckResult> {
  const base = credentials.baseUrl.replace(/\/+$/, "");
  const url = `${base}/player_api.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(credentials.password)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_STATUS_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `provider responded with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { user_info?: { auth?: number | boolean } };
    if (body.user_info?.auth === 1 || body.user_info?.auth === true) {
      return { ok: true };
    }
    return { ok: false, error: "provider rejected credentials" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "timed out contacting provider" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "unknown error contacting provider" };
  } finally {
    clearTimeout(timeout);
  }
}

// M3U providers have no auth endpoint — a playlist URL either serves a
// valid M3U document or it doesn't. Fetching the whole body (rather than a
// Range request for the first bytes) is deliberate: playlists this size are
// small enough (KBs-low MBs) that it's not worth the added complexity for
// an occasional test check.
export async function checkM3uPlaylist(playlistUrl: string): Promise<AuthCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_STATUS_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(playlistUrl, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `provider responded with HTTP ${response.status}` };
    }
    const body = await response.text();
    if (body.trimStart().startsWith("#EXTM3U")) {
      return { ok: true };
    }
    return { ok: false, error: "response is not a valid M3U playlist" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "timed out contacting provider" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "unknown error contacting provider" };
  } finally {
    clearTimeout(timeout);
  }
}

export function checkProviderAuth(provider: typeof providers.$inferSelect): Promise<AuthCheckResult> {
  const connection = resolveProviderConnection(provider);
  if (connection.type === "m3u") {
    return checkM3uPlaylist(connection.playlistUrl);
  }
  return checkXtreamAuth(connection);
}
