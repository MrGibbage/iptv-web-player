import type { FastifyInstance } from "fastify";
import { listLiveCategories, listLiveChannels } from "../liveChannels.js";

// PLAN.md "Live TV channel browsing" — nested under /providers/:id/live/*,
// same convention as /providers/:id/epg/*. Unified across Xtream and M3U by
// ../liveChannels.ts, so these routes never branch on provider type
// themselves.

const liveCategorySchema = {
  $id: "LiveCategory",
  type: "object",
  properties: {
    categoryId: { type: "string" },
    categoryName: { type: "string" },
  },
  required: ["categoryId", "categoryName"],
} as const;

const liveChannelSchema = {
  $id: "LiveChannel",
  type: "object",
  properties: {
    channelId: { type: "string" },
    name: { type: "string" },
    streamIcon: { type: "string", nullable: true },
    categoryId: { type: "string", nullable: true },
    epgChannelId: { type: "string", nullable: true },
  },
  required: ["channelId", "name", "streamIcon", "categoryId", "epgChannelId"],
} as const;

export async function liveRoutes(app: FastifyInstance) {
  app.addSchema(liveCategorySchema);
  app.addSchema(liveChannelSchema);

  app.get<{ Params: { id: string } }>(
    "/providers/:id/live/categories",
    {
      schema: {
        tags: ["live"],
        summary: "List live categories for a provider",
        response: { 200: { type: "array", items: { $ref: "LiveCategory#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        return await listLiveCategories(Number(request.params.id));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { categoryId?: string } }>(
    "/providers/:id/live/channels",
    {
      schema: {
        tags: ["live"],
        summary: "List live channels for a provider",
        description: "Omit categoryId to list every channel regardless of category.",
        querystring: {
          type: "object",
          properties: { categoryId: { type: "string" } },
        },
        response: { 200: { type: "array", items: { $ref: "LiveChannel#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        return await listLiveChannels(Number(request.params.id), request.query.categoryId);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
