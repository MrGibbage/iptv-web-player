import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ProviderConnection } from "../recorderClient.js";
import * as epgDb from "./epgDb.js";
import { parseXmltvFile } from "./xmltv.js";
import { log } from "../logger.js";

// Ported from Laomedeia (electron/epg.ts) — same refresh policy (TTL-gated
// unless forced, staging-swap ingest) and same Xtream-derives-its-own-URL /
// M3U-needs-a-manual-URL split (PLAN.md "EPG ingestion").
//
// Two real changes from the original:
//   - No `onStatusChange` push callback — that existed to notify Laomedeia's
//     renderer over IPC. This is a stateless REST API; callers poll
//     GET /providers/:id/epg/status instead.
//   - Per-provider state (a Map) instead of module-level singletons —
//     Laomedeia only ever had one active provider at a time; this app can
//     have several (one per configured provider, see ../providerSource.ts),
//     each refreshing independently.

export interface EpgStatus {
  state: "idle" | "refreshing" | "error";
  phase: "download" | "ingest" | null;
  lastRefreshMs: number | null;
  channelCount: number;
  programCount: number;
  error: string | null;
}

const REFRESH_TTL_MS = 12 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const LAST_REFRESH_KEY = "lastRefreshMs";
const EPG_DATA_DIR = process.env.EPG_DATA_DIR ?? "./data/epg";

interface RefreshState {
  refreshing: boolean;
  phase: EpgStatus["phase"];
  lastError: string | null;
}

const states = new Map<string, RefreshState>();

function getState(providerKey: string): RefreshState {
  let state = states.get(providerKey);
  if (!state) {
    state = { refreshing: false, phase: null, lastError: null };
    states.set(providerKey, state);
  }
  return state;
}

export function getStatus(providerKey: string): EpgStatus {
  const state = getState(providerKey);
  const last = epgDb.getMeta(providerKey, LAST_REFRESH_KEY);
  const counts = epgDb.getCounts(providerKey);
  return {
    state: state.refreshing ? "refreshing" : state.lastError ? "error" : "idle",
    phase: state.phase,
    lastRefreshMs: last != null ? Number(last) : null,
    channelCount: counts.channels,
    programCount: counts.programs,
    error: state.lastError,
  };
}

// Xtream always has a guide at a derived URL; M3U has no such convention, so
// its guide comes from the provider's own optional epgUrl field (paired
// playlists like Apollo Group's don't expose one through the M3U itself) —
// null when unset.
function resolveXmltvUrl(connection: ProviderConnection): string | null {
  if (connection.type === "xtream") {
    const base = connection.baseUrl.trim().replace(/\/+$/, "");
    const url = new URL(`${base}/xmltv.php`);
    url.searchParams.set("username", connection.username);
    url.searchParams.set("password", connection.password);
    return url.toString();
  }
  return connection.epgUrl?.trim() || null;
}

async function downloadXmltv(sourceUrl: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`EPG download failed: HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("EPG download failed: empty response body");
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destPath));
  } finally {
    clearTimeout(timeout);
  }
}

async function ingestFile(providerKey: string, filePath: string): Promise<{ channelCount: number; programCount: number }> {
  const ingest = epgDb.beginReplaceIngest(providerKey);
  // Program FTS rows carry the channel name so search can match on it;
  // XMLTV lists all channels before any programs, so this map is complete
  // by the time programs arrive.
  const channelNames = new Map<string, string>();
  try {
    const result = await parseXmltvFile(filePath, {
      onChannels(batch) {
        for (const ch of batch) {
          channelNames.set(ch.id, ch.displayName);
          ingest.insertChannel({ id: ch.id, displayName: ch.displayName, icon: ch.icon });
        }
      },
      onPrograms(batch) {
        for (const p of batch) {
          ingest.insertProgram({
            channelId: p.channelId,
            startMs: p.startMs,
            stopMs: p.stopMs,
            title: p.title,
            description: p.description,
            channelName: channelNames.get(p.channelId) ?? "",
          });
        }
      },
    });
    ingest.commit();
    return result;
  } catch (err) {
    ingest.rollback();
    throw err;
  }
}

export async function refresh(providerKey: string, connection: ProviderConnection, force = false): Promise<EpgStatus> {
  const state = getState(providerKey);
  if (state.refreshing) return getStatus(providerKey);

  if (!force) {
    const last = epgDb.getMeta(providerKey, LAST_REFRESH_KEY);
    if (last != null && Date.now() - Number(last) < REFRESH_TTL_MS) {
      return getStatus(providerKey);
    }
  }

  const sourceUrl = resolveXmltvUrl(connection);
  if (!sourceUrl) {
    state.lastError = "No EPG URL configured for this provider.";
    return getStatus(providerKey);
  }

  state.refreshing = true;
  state.lastError = null;
  const startedAt = Date.now();
  log("epg", `${providerKey}: refresh started force=${force}`);

  // Dev override: point IPTV_EPG_FILE at a local XMLTV file to skip the
  // provider download.
  const overrideFile = process.env.IPTV_EPG_FILE;
  await fs.mkdir(EPG_DATA_DIR, { recursive: true });
  const downloadPath = path.join(EPG_DATA_DIR, `epg-download-${providerKey}.xml`);

  try {
    let sourceFile: string;
    if (overrideFile) {
      sourceFile = overrideFile;
    } else {
      state.phase = "download";
      await downloadXmltv(sourceUrl, downloadPath);
      sourceFile = downloadPath;
    }

    state.phase = "ingest";
    await ingestFile(providerKey, sourceFile);
    epgDb.setMeta(providerKey, LAST_REFRESH_KEY, String(Date.now()));
    const counts = epgDb.getCounts(providerKey);
    log("epg", `${providerKey}: refresh completed in ${Date.now() - startedAt}ms channels=${counts.channels} programs=${counts.programs}`);
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    log("epg", `${providerKey}: refresh failed in ${Date.now() - startedAt}ms: ${state.lastError}`);
  } finally {
    state.refreshing = false;
    state.phase = null;
    if (!overrideFile) {
      await fs.rm(downloadPath, { force: true }).catch(() => {});
    }
  }
  return getStatus(providerKey);
}
