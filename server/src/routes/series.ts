import type { FastifyInstance } from "fastify";
import { listSeriesCategories, listSeriesList, getSeriesDetails } from "../series.js";

const seriesCategorySchema = {
  $id: "SeriesCategory",
  type: "object",
  properties: {
    categoryId: { type: "string" },
    categoryName: { type: "string" },
  },
  required: ["categoryId", "categoryName"],
} as const;

const seriesListItemSchema = {
  $id: "SeriesListItem",
  type: "object",
  properties: {
    seriesId: { type: "integer" },
    name: { type: "string" },
    cover: { type: "string", nullable: true },
    categoryId: { type: "string" },
    rating: { type: "number", nullable: true },
  },
  required: ["seriesId", "name", "cover", "categoryId", "rating"],
} as const;

const seriesEpisodeSchema = {
  $id: "SeriesEpisode",
  type: "object",
  properties: {
    id: { type: "string" },
    episodeNum: { type: "integer" },
    title: { type: "string" },
    containerExtension: { type: "string" },
    season: { type: "integer" },
    plot: { type: "string", nullable: true },
    duration: { type: "string", nullable: true },
  },
  required: ["id", "episodeNum", "title", "containerExtension", "season", "plot", "duration"],
} as const;

const seriesSeasonSchema = {
  $id: "SeriesSeason",
  type: "object",
  properties: {
    seasonNumber: { type: "integer" },
    name: { type: "string", nullable: true },
    episodes: { type: "array", items: { $ref: "SeriesEpisode#" } },
  },
  required: ["seasonNumber", "name", "episodes"],
} as const;

const seriesInfoSchema = {
  $id: "SeriesInfo",
  type: "object",
  properties: {
    name: { type: "string" },
    cover: { type: "string", nullable: true },
    plot: { type: "string", nullable: true },
    cast: { type: "string", nullable: true },
    director: { type: "string", nullable: true },
    genre: { type: "string", nullable: true },
    releaseDate: { type: "string", nullable: true },
    rating: { type: "number", nullable: true },
    seasons: { type: "array", items: { $ref: "SeriesSeason#" } },
  },
  required: ["name", "cover", "plot", "cast", "director", "genre", "releaseDate", "rating", "seasons"],
} as const;

export async function seriesRoutes(app: FastifyInstance) {
  app.addSchema(seriesCategorySchema);
  app.addSchema(seriesListItemSchema);
  app.addSchema(seriesEpisodeSchema);
  app.addSchema(seriesSeasonSchema);
  app.addSchema(seriesInfoSchema);

  app.get<{ Params: { id: string } }>(
    "/providers/:id/series/categories",
    {
      schema: {
        tags: ["series"],
        summary: "List series categories for a provider",
        response: { 200: { type: "array", items: { $ref: "SeriesCategory#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        return await listSeriesCategories(Number(request.params.id));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { categoryId?: string } }>(
    "/providers/:id/series/list",
    {
      schema: {
        tags: ["series"],
        summary: "List TV shows for a provider",
        description: "Omit categoryId to lazy-load the entire library (used for the 'search all' scope).",
        querystring: {
          type: "object",
          properties: { categoryId: { type: "string" } },
        },
        response: { 200: { type: "array", items: { $ref: "SeriesListItem#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        return await listSeriesList(Number(request.params.id), request.query.categoryId);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Params: { id: string; seriesId: string } }>(
    "/providers/:id/series/list/:seriesId",
    {
      schema: {
        tags: ["series"],
        summary: "Get a show's details, seasons, and episodes",
        response: { 200: { $ref: "SeriesInfo#" }, 404: { $ref: "Error#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        const info = await getSeriesDetails(Number(request.params.id), Number(request.params.seriesId));
        if (!info) return reply.code(404).send({ error: "show not found" });
        return info;
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
