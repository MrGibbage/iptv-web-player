import { decrypt } from "../crypto.js";
import type { providers } from "../db/schema.js";
import type { ProviderConnection } from "../recorderClient.js";

type ProviderRow = typeof providers.$inferSelect;

// The providers_type_shape CHECK constraint (../db/schema.ts) guarantees a
// row's nullable columns match its `type`, but Drizzle's inferred row type
// can't express that correlation. Narrowing it once here, with a decrypt
// pass on the relevant fields, avoids scattering non-null assertions
// through every caller that needs a local provider's connection details.
// Returns the same ProviderConnection shape iptv-recorder hands back over
// GET /providers/{id}/connection, so ../providerSource.ts can treat a local
// row and a recorder-sourced one identically.
export function resolveProviderConnection(provider: ProviderRow): ProviderConnection {
  if (provider.type === "xtream") {
    if (provider.baseUrl === null || provider.usernameEncrypted === null || provider.passwordEncrypted === null) {
      throw new Error(`provider ${provider.id} is type=xtream but missing xtream fields`);
    }
    return {
      type: "xtream",
      baseUrl: provider.baseUrl,
      username: decrypt(provider.usernameEncrypted),
      password: decrypt(provider.passwordEncrypted),
    };
  }
  if (provider.playlistUrlEncrypted === null) {
    throw new Error(`provider ${provider.id} is type=m3u but missing playlistUrlEncrypted`);
  }
  return {
    type: "m3u",
    playlistUrl: decrypt(provider.playlistUrlEncrypted),
    epgUrl: provider.epgUrlEncrypted === null ? null : decrypt(provider.epgUrlEncrypted),
  };
}
