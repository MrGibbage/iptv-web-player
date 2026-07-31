import type { FastifyInstance } from "fastify";
import { getEffectiveProviderConnection, providerCacheKey, ProviderSourceNotConfiguredError } from "../providerSource.js";
import * as epgDb from "../epg/epgDb.js";
import { getStatus, refresh } from "../epg/epg.js";

// PLAN.md "EPG ingestion" — nested under /providers/:id/epg/* since a guide
// is always scoped to one provider. Status/programs/search/bounds are pure
// local reads (epgDb.ts) and never touch the network, so they stay fast and
// available even if the provider itself is unreachable at that instant —
// only POST /refresh actually needs a live connection.

const epgStatusSchema = {
  $id: "EpgStatus",
  type: "object",
  properties: {
    state: { type: "string", enum: ["idle", "refreshing", "error"] },
    phase: { type: "string", enum: ["download", "ingest"], nullable: true },
    lastRefreshMs: { type: "integer", nullable: true },
    channelCount: { type: "integer" },
    programCount: { type: "integer" },
    error: { type: "string", nullable: true },
  },
  required: ["state", "phase", "lastRefreshMs", "channelCount", "programCount", "error"],
} as const;

const epgProgramSchema = {
  $id: "EpgProgram",
  type: "object",
  properties: {
    id: { type: "integer" },
    channelId: { type: "string" },
    startMs: { type: "integer" },
    stopMs: { type: "integer" },
    title: { type: "string" },
    description: { type: "string" },
  },
  required: ["id", "channelId", "startMs", "stopMs", "title", "description"],
} as const;

const epgSearchResultSchema = {
  $id: "EpgSearchResult",
  type: "object",
  properties: {
    id: { type: "integer" },
    channelId: { type: "string" },
    startMs: { type: "integer" },
    stopMs: { type: "integer" },
    title: { type: "string" },
    description: { type: "string" },
    channelName: { type: "string" },
  },
  required: ["id", "channelId", "startMs", "stopMs", "title", "description", "channelName"],
} as const;

const epgBoundsSchema = {
  $id: "EpgBounds",
  type: "object",
  properties: {
    minStartMs: { type: "integer", nullable: true },
    maxStopMs: { type: "integer", nullable: true },
  },
  required: ["minStartMs", "maxStopMs"],
} as const;

function resolveCacheKey(id: string): string | null {
  try {
    return providerCacheKey(Number(id));
  } catch (err) {
    if (err instanceof ProviderSourceNotConfiguredError) return null;
    throw err;
  }
}

export async function epgRoutes(app: FastifyInstance) {
  app.addSchema(epgStatusSchema);
  app.addSchema(epgProgramSchema);
  app.addSchema(epgSearchResultSchema);
  app.addSchema(epgBoundsSchema);

  app.get<{ Params: { id: string } }>(
    "/providers/:id/epg/status",
    {
      schema: {
        tags: ["epg"],
        summary: "Get EPG refresh status for a provider",
        response: { 200: { $ref: "EpgStatus#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const key = resolveCacheKey(request.params.id);
      if (!key) return reply.code(400).send({ error: "no provider source configured yet" });
      return getStatus(key);
    },
  );

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
    "/providers/:id/epg/refresh",
    {
      schema: {
        tags: ["epg"],
        summary: "Refresh a provider's EPG",
        description: "No-ops (returns current status) if the 12h TTL hasn't elapsed yet, unless force is true.",
        body: {
          type: "object",
          properties: { force: { type: "boolean" } },
          additionalProperties: false,
        },
        response: { 200: { $ref: "EpgStatus#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const key = resolveCacheKey(request.params.id);
      if (!key) return reply.code(400).send({ error: "no provider source configured yet" });
      try {
        const connection = await getEffectiveProviderConnection(id);
        return await refresh(key, connection, request.body?.force ?? false);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { channelIds?: string; from?: string; to?: string } }>(
    "/providers/:id/epg/programs",
    {
      schema: {
        tags: ["epg"],
        summary: "Get programs for a set of channels in a time range",
        querystring: {
          type: "object",
          required: ["channelIds", "from", "to"],
          properties: {
            channelIds: { type: "string", description: "Comma-separated XMLTV channel ids" },
            from: { type: "string", description: "Range start, epoch ms" },
            to: { type: "string", description: "Range end, epoch ms" },
          },
        },
        response: { 200: { type: "array", items: { $ref: "EpgProgram#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const key = resolveCacheKey(request.params.id);
      if (!key) return reply.code(400).send({ error: "no provider source configured yet" });
      const { channelIds, from, to } = request.query;
      const ids = (channelIds ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      return epgDb.getPrograms(key, ids, Number(from), Number(to));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    "/providers/:id/epg/search",
    {
      schema: {
        tags: ["epg"],
        summary: "Search programs and channel names",
        querystring: {
          type: "object",
          required: ["q"],
          properties: { q: { type: "string" } },
        },
        response: { 200: { type: "array", items: { $ref: "EpgSearchResult#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const key = resolveCacheKey(request.params.id);
      if (!key) return reply.code(400).send({ error: "no provider source configured yet" });
      return epgDb.search(key, request.query.q ?? "");
    },
  );

  app.get<{ Params: { id: string } }>(
    "/providers/:id/epg/bounds",
    {
      schema: {
        tags: ["epg"],
        summary: "Get the earliest/latest program times currently cached",
        response: { 200: { $ref: "EpgBounds#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const key = resolveCacheKey(request.params.id);
      if (!key) return reply.code(400).send({ error: "no provider source configured yet" });
      return epgDb.getBounds(key);
    },
  );
}
