import type { FastifyInstance } from "fastify";
import { listVodCategories, listVodStreams, getVodDetails } from "../vod.js";

const vodCategorySchema = {
  $id: "VodCategory",
  type: "object",
  properties: {
    categoryId: { type: "string" },
    categoryName: { type: "string" },
  },
  required: ["categoryId", "categoryName"],
} as const;

const vodStreamSchema = {
  $id: "VodStream",
  type: "object",
  properties: {
    streamId: { type: "integer" },
    name: { type: "string" },
    streamIcon: { type: "string", nullable: true },
    categoryId: { type: "string" },
    containerExtension: { type: "string" },
    rating: { type: "number", nullable: true },
    added: { type: "string", nullable: true },
  },
  required: ["streamId", "name", "streamIcon", "categoryId", "containerExtension", "rating", "added"],
} as const;

const vodInfoSchema = {
  $id: "VodInfo",
  type: "object",
  properties: {
    plot: { type: "string", nullable: true },
    cast: { type: "string", nullable: true },
    director: { type: "string", nullable: true },
    genre: { type: "string", nullable: true },
    releaseDate: { type: "string", nullable: true },
    duration: { type: "string", nullable: true },
    rating: { type: "number", nullable: true },
    containerExtension: { type: "string" },
  },
  required: ["plot", "cast", "director", "genre", "releaseDate", "duration", "rating", "containerExtension"],
} as const;

export async function vodRoutes(app: FastifyInstance) {
  app.addSchema(vodCategorySchema);
  app.addSchema(vodStreamSchema);
  app.addSchema(vodInfoSchema);

  app.get<{ Params: { id: string } }>(
    "/providers/:id/vod/categories",
    {
      schema: {
        tags: ["vod"],
        summary: "List VOD categories for a provider",
        response: { 200: { type: "array", items: { $ref: "VodCategory#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        return await listVodCategories(Number(request.params.id));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { categoryId?: string } }>(
    "/providers/:id/vod/streams",
    {
      schema: {
        tags: ["vod"],
        summary: "List VOD titles for a provider",
        description: "Omit categoryId to lazy-load the entire library (used for the 'search all' scope) — can be a large, slower request.",
        querystring: {
          type: "object",
          properties: { categoryId: { type: "string" } },
        },
        response: { 200: { type: "array", items: { $ref: "VodStream#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        return await listVodStreams(Number(request.params.id), request.query.categoryId);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Params: { id: string; vodId: string } }>(
    "/providers/:id/vod/streams/:vodId",
    {
      schema: {
        tags: ["vod"],
        summary: "Get VOD title details (plot, cast, director, genre, rating)",
        response: { 200: { $ref: "VodInfo#" }, 404: { $ref: "Error#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        const info = await getVodDetails(Number(request.params.id), Number(request.params.vodId));
        if (!info) return reply.code(404).send({ error: "title not found" });
        return info;
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
