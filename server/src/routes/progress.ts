import type { FastifyInstance } from "fastify";
import { getProgress, saveProgress, type MediaType } from "../progress.js";

const progressSchema = {
  $id: "Progress",
  type: "object",
  properties: {
    positionSecs: { type: "integer" },
    durationSecs: { type: "integer", nullable: true },
  },
  required: ["positionSecs", "durationSecs"],
} as const;

const saveProgressBodySchema = {
  type: "object",
  required: ["positionSecs"],
  properties: {
    positionSecs: { type: "number" },
    durationSecs: { type: "number", nullable: true },
  },
  additionalProperties: false,
} as const;

export async function progressRoutes(app: FastifyInstance) {
  app.addSchema(progressSchema);

  app.get<{ Params: { id: string; mediaType: MediaType; mediaId: string } }>(
    "/providers/:id/progress/:mediaType/:mediaId",
    {
      schema: {
        tags: ["progress"],
        summary: "Get a saved resume position for a VOD title or series episode",
        response: { 200: { $ref: "Progress#" }, 404: { $ref: "Error#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        const providerId = Number(request.params.id);
        const result = getProgress(providerId, request.params.mediaType, request.params.mediaId);
        if (!result) return reply.code(404).send({ error: "no saved progress" });
        return result;
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.put<{ Params: { id: string; mediaType: MediaType; mediaId: string }; Body: { positionSecs: number; durationSecs?: number | null } }>(
    "/providers/:id/progress/:mediaType/:mediaId",
    {
      schema: {
        tags: ["progress"],
        summary: "Save (or clear, if near the start/end) a resume position",
        description: "Positions within 10s of the start or 30s of the end are dropped instead of saved — see progress.ts.",
        body: saveProgressBodySchema,
        response: { 204: {}, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        const providerId = Number(request.params.id);
        const { positionSecs, durationSecs } = request.body;
        saveProgress(providerId, request.params.mediaType, request.params.mediaId, positionSecs, durationSecs ?? null);
        reply.code(204).send();
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
