import type { FastifyInstance } from "fastify";
import { getProviderSourceConfig, getRecorderConfig, setProviderSourceMode, setRecorderConfig, getPlayerSettings, setPlayerSettings } from "../db/settings.js";
import { listProviders as listRecorderProviders, testRecorderConnection } from "../recorderClient.js";

// PLAN.md "Credentials Model" — the "ask first" setup screen: has this
// instance chosen to source providers from iptv-recorder, or does it keep
// its own local credential store? Deliberately no default — see
// ../db/schema.ts providerSourceConfig for why unset is a real state, not
// an error.
const providerSourceSchema = {
  $id: "ProviderSourceConfig",
  type: "object",
  properties: {
    mode: { type: "string", enum: ["recorder", "local"], nullable: true },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["mode", "updatedAt"],
} as const;

const providerSourceUpdateSchema = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["recorder", "local"] },
  },
  additionalProperties: false,
} as const;

function toProviderSourceResponse(config: { mode: "recorder" | "local" | null; updatedAt: Date }) {
  return { mode: config.mode, updatedAt: config.updatedAt.toISOString() };
}

const recorderUpdateSchema = {
  type: "object",
  required: ["baseUrl", "apiKey"],
  properties: {
    baseUrl: { type: "string", minLength: 1 },
    apiKey: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

type RecorderUpdateBody = {
  baseUrl: string;
  apiKey: string;
};

// The API key is never returned, encrypted or otherwise — mirrors
// iptv-scheduler's own /config/recorder exactly; `configured` is the only
// signal a client gets for whether one is set.
const recorderConfigSchema = {
  $id: "RecorderConfig",
  type: "object",
  properties: {
    baseUrl: { type: "string", nullable: true },
    configured: { type: "boolean", description: "True once both a baseUrl and a working apiKey have been saved." },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["baseUrl", "configured", "updatedAt"],
} as const;

function toRecorderResponse(config: { baseUrl: string | null; apiKeyEncrypted: string | null; updatedAt: Date }) {
  return {
    baseUrl: config.baseUrl,
    configured: Boolean(config.baseUrl && config.apiKeyEncrypted),
    updatedAt: config.updatedAt.toISOString(),
  };
}

// PLAN.md "Live TV preview" — how long an unpromoted channel preview plays
// before the client auto-closes it. Purely a client-side timer (Player.tsx);
// this endpoint just persists the user's chosen value across reloads, the
// same way any other setting here does.
const playerSettingsSchema = {
  $id: "PlayerSettings",
  type: "object",
  properties: {
    previewTimeoutSecs: { type: "integer", minimum: 5, maximum: 300 },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["previewTimeoutSecs", "updatedAt"],
} as const;

const playerSettingsUpdateSchema = {
  type: "object",
  required: ["previewTimeoutSecs"],
  properties: {
    previewTimeoutSecs: { type: "integer", minimum: 5, maximum: 300 },
  },
  additionalProperties: false,
} as const;

function toPlayerSettingsResponse(settings: { previewTimeoutSecs: number; updatedAt: Date }) {
  return { previewTimeoutSecs: settings.previewTimeoutSecs, updatedAt: settings.updatedAt.toISOString() };
}

const recorderProviderSchema = {
  $id: "RecorderProvider",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: ["string", "null"] },
    enabled: { type: "boolean" },
  },
  required: ["id", "name", "type", "baseUrl", "enabled"],
} as const;

// PLAN.md "Credentials Model" — this app has no auth at all (single-user,
// LAN-only decision), same single-operator-homelab assumption as
// iptv-recorder/iptv-scheduler use today.
export async function configRoutes(app: FastifyInstance) {
  app.addSchema(providerSourceSchema);

  app.get(
    "/config/provider-source",
    {
      schema: {
        tags: ["config"],
        summary: "Get provider-source mode",
        description: "'recorder': providers come from iptv-recorder. 'local': this app owns its own provider store. null: not yet chosen.",
        response: { 200: { $ref: "ProviderSourceConfig#" } },
      },
    },
    async () => toProviderSourceResponse(getProviderSourceConfig()),
  );

  app.put<{ Body: { mode: "recorder" | "local" } }>(
    "/config/provider-source",
    {
      schema: {
        tags: ["config"],
        summary: "Set provider-source mode",
        description: "Switching modes doesn't clear the other mode's settings — e.g. switching from local back to recorder keeps local providers in place, unused, until switched back.",
        body: providerSourceUpdateSchema,
        response: { 200: { $ref: "ProviderSourceConfig#" } },
      },
    },
    async (request) => toProviderSourceResponse(setProviderSourceMode(request.body.mode)),
  );

  app.addSchema(playerSettingsSchema);

  app.get(
    "/config/player",
    {
      schema: {
        tags: ["config"],
        summary: "Get player UX settings",
        response: { 200: { $ref: "PlayerSettings#" } },
      },
    },
    async () => toPlayerSettingsResponse(getPlayerSettings()),
  );

  app.put<{ Body: { previewTimeoutSecs: number } }>(
    "/config/player",
    {
      schema: {
        tags: ["config"],
        summary: "Set player UX settings",
        body: playerSettingsUpdateSchema,
        response: { 200: { $ref: "PlayerSettings#" } },
      },
    },
    async (request) => toPlayerSettingsResponse(setPlayerSettings(request.body)),
  );

  app.addSchema(recorderConfigSchema);
  app.addSchema(recorderProviderSchema);

  app.get(
    "/config/recorder",
    {
      schema: {
        tags: ["config"],
        summary: "Get recorder connection config",
        response: { 200: { $ref: "RecorderConfig#" } },
      },
    },
    async () => toRecorderResponse(getRecorderConfig()),
  );

  // Tests the candidate baseUrl/apiKey against iptv-recorder before saving
  // anything — same "test before persisting" principle as iptv-recorder's
  // own POST /providers/test and iptv-scheduler's PUT /config/recorder.
  app.put<{ Body: RecorderUpdateBody }>(
    "/config/recorder",
    {
      schema: {
        tags: ["config"],
        summary: "Set recorder connection config",
        description: "Tests the candidate baseUrl/apiKey against iptv-recorder before saving — a bad pair is rejected with a reason instead of failing silently later.",
        body: recorderUpdateSchema,
        response: { 200: { $ref: "RecorderConfig#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const { baseUrl, apiKey } = request.body;
      const result = await testRecorderConnection({ baseUrl, apiKey });
      if (!result.ok) {
        return reply.code(400).send({ error: `could not connect to iptv-recorder: ${result.error}` });
      }
      return toRecorderResponse(setRecorderConfig({ baseUrl, apiKey }));
    },
  );

  // Read-only proxy of iptv-recorder's own GET /providers — lets the
  // Settings UI show what's available from recorder mode without this app
  // needing to duplicate any of it locally. The actual browsing UI (Live/
  // VOD/Series, not built yet) uses ../providerSource.ts instead, which is
  // mode-aware; this route exists purely for the recorder-mode Settings
  // screen to display "here's what's configured over there."
  app.get(
    "/config/recorder/providers",
    {
      schema: {
        tags: ["config"],
        summary: "List iptv-recorder's providers",
        description: "Proxies iptv-recorder's GET /providers. Requires /config/recorder to already be configured.",
        response: { 200: { type: "array", items: { $ref: "RecorderProvider#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (_request, reply) => {
      try {
        return await listRecorderProviders();
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
