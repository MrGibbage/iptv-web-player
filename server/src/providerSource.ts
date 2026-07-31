import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { providers } from "./db/schema.js";
import { getProviderSourceConfig } from "./db/settings.js";
import * as recorderClient from "./recorderClient.js";
import { resolveProviderConnection } from "./worker/providerShape.js";
import type { ProviderConnection } from "./recorderClient.js";

// Mode-aware provider access (PLAN.md "Credentials Model") — every future
// feature that needs "what providers exist" or "give me provider N's real
// connection details" (EPG ingestion, live/VOD/series browsing, playback)
// should go through this module, not ../recorderClient.ts or
// ./db/schema.ts's providers table directly. That keeps the "recorder vs
// local" choice contained to one place instead of every downstream feature
// needing its own branch on providerSourceConfig.mode.

export type ProviderSummary = {
  id: number;
  name: string;
  type: "xtream" | "m3u";
  baseUrl: string | null;
  enabled: boolean;
};

export class ProviderSourceNotConfiguredError extends Error {
  constructor() {
    super("no provider source configured yet (see PUT /config/provider-source)");
    this.name = "ProviderSourceNotConfiguredError";
  }
}

function toSummary(row: { id: number; name: string; type: "xtream" | "m3u"; baseUrl: string | null; enabled: boolean }): ProviderSummary {
  return { id: row.id, name: row.name, type: row.type, baseUrl: row.baseUrl, enabled: row.enabled };
}

export async function listEffectiveProviders(): Promise<ProviderSummary[]> {
  const config = getProviderSourceConfig();
  if (config.mode === "recorder") {
    const remote = await recorderClient.listProviders();
    return remote.map(toSummary);
  }
  if (config.mode === "local") {
    return db.select().from(providers).all().map(toSummary);
  }
  throw new ProviderSourceNotConfiguredError();
}

export async function getEffectiveProviderConnection(id: number): Promise<ProviderConnection> {
  const config = getProviderSourceConfig();
  if (config.mode === "recorder") {
    return recorderClient.getProviderConnection(id);
  }
  if (config.mode === "local") {
    const [row] = db.select().from(providers).where(eq(providers.id, id)).all();
    if (!row) {
      throw new Error(`provider ${id} not found`);
    }
    return resolveProviderConnection(row);
  }
  throw new ProviderSourceNotConfiguredError();
}

// Namespaces a provider id by the current source mode (`recorder-3` vs
// `local-3`) for anything that caches per-provider data on disk (EPG guide
// caches so far — see ../epg/epgDb.ts). Recorder ids and local ids are
// different, unrelated numeric spaces; without this prefix, switching modes
// could silently reuse another provider's cache file if the ids ever
// happened to collide numerically.
export function providerCacheKey(id: number): string {
  const config = getProviderSourceConfig();
  if (config.mode === null) {
    throw new ProviderSourceNotConfiguredError();
  }
  return `${config.mode}-${id}`;
}
