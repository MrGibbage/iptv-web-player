import { listEffectiveProviders, getEffectiveProviderConnection, providerCacheKey, ProviderSourceNotConfiguredError } from "../providerSource.js";
import { refresh } from "./epg.js";
import { log } from "../logger.js";

// Ported from Laomedeia (electron/main.ts's refreshEpgIfConfigured +
// setInterval(..., 60 * 60 * 1000)) — refresh on startup (refresh() itself
// no-ops if the 12h TTL hasn't elapsed, see ./epg.ts), then check hourly.
// Generalized from "one active provider" to "every configured provider",
// since this app can have more than one (PLAN.md "Credentials Model").

const HOURLY_CHECK_MS = 60 * 60 * 1000;

let interval: ReturnType<typeof setInterval> | null = null;

async function refreshAllIfConfigured(force = false): Promise<void> {
  let providers;
  try {
    providers = await listEffectiveProviders();
  } catch (err) {
    // No provider source chosen yet ("ask first" not answered) or the
    // recorder connection isn't reachable — both are real, expected states
    // to skip quietly rather than treat as a scheduler failure.
    if (err instanceof ProviderSourceNotConfiguredError) return;
    log("epg", `could not list providers for refresh: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const provider of providers) {
    if (!provider.enabled) continue;
    try {
      const connection = await getEffectiveProviderConnection(provider.id);
      await refresh(providerCacheKey(provider.id), connection, force);
    } catch (err) {
      // One provider's failure (unreachable, bad connection info) shouldn't
      // stop the rest of the loop from refreshing.
      log("epg", `provider ${provider.id} refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function startEpgRefresh(): void {
  refreshAllIfConfigured();
  interval = setInterval(() => refreshAllIfConfigured(), HOURLY_CHECK_MS);
}

export function stopEpgRefresh(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export { refreshAllIfConfigured };
