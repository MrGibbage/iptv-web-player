import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { providerSourceConfig, recorderConfig } from "./schema.js";
import { encrypt } from "../crypto.js";

// Singleton row, created with mode=null the first time anything asks for
// it — unset is a real, expected first-boot state ("ask first" at setup
// time), not an error. See ../db/schema.ts for what each mode means.
export function getProviderSourceConfig(): typeof providerSourceConfig.$inferSelect {
  const [existing] = db.select().from(providerSourceConfig).all();
  if (existing) {
    return existing;
  }
  const [created] = db.insert(providerSourceConfig).values({}).returning().all();
  return created;
}

export function setProviderSourceMode(mode: "recorder" | "local"): typeof providerSourceConfig.$inferSelect {
  const current = getProviderSourceConfig();
  const [updated] = db
    .update(providerSourceConfig)
    .set({ mode, updatedAt: new Date() })
    .where(eq(providerSourceConfig.id, current.id))
    .returning()
    .all();
  return updated;
}

// Singleton row, created empty (both columns null) the first time anything
// asks for it — mirrors iptv-scheduler's own getRecorderConfig exactly.
export function getRecorderConfig(): typeof recorderConfig.$inferSelect {
  const [existing] = db.select().from(recorderConfig).all();
  if (existing) {
    return existing;
  }
  const [created] = db.insert(recorderConfig).values({}).returning().all();
  return created;
}

export function setRecorderConfig(input: { baseUrl: string; apiKey: string }): typeof recorderConfig.$inferSelect {
  const current = getRecorderConfig();
  const [updated] = db
    .update(recorderConfig)
    .set({
      baseUrl: input.baseUrl,
      apiKeyEncrypted: encrypt(input.apiKey),
      updatedAt: new Date(),
    })
    .where(eq(recorderConfig.id, current.id))
    .returning()
    .all();
  return updated;
}

// PLAN.md "Forget recorder connection" — real gap found via testing: going
// Change source -> "Use iptv-recorder's credentials" doesn't clear this row
// at all (it's a separate table from provider_source_config, untouched by
// that choice), so re-choosing recorder mode always resurrects whatever was
// already saved rather than offering a fresh connection form. This is the
// only way to actually reset it back to unconfigured.
export function clearRecorderConfig(): typeof recorderConfig.$inferSelect {
  const current = getRecorderConfig();
  const [updated] = db
    .update(recorderConfig)
    .set({ baseUrl: null, apiKeyEncrypted: null, updatedAt: new Date() })
    .where(eq(recorderConfig.id, current.id))
    .returning()
    .all();
  return updated;
}
