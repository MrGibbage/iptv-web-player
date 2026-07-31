import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { startSession, stopSession, touchSession, getSessionFilePath, getSessionStatus } from "../playback/hlsSession.js";

// PLAN.md "Playback architecture" — starting a session needs provider
// context (/providers/:id/...), but once started a session is addressed
// purely by its own opaque id; nothing else needs to know which provider or
// channel it came from.

const startStreamBodySchema = {
  type: "object",
  required: ["channelId"],
  properties: { channelId: { type: "string" } },
  additionalProperties: false,
} as const;

const streamSessionSchema = {
  $id: "StreamSession",
  type: "object",
  properties: {
    sessionId: { type: "string" },
    playlistUrl: { type: "string" },
  },
  required: ["sessionId", "playlistUrl"],
} as const;

const streamStatusSchema = {
  $id: "StreamStatus",
  type: "object",
  properties: {
    status: { type: "string", enum: ["starting", "running", "error"] },
    error: { type: "string", nullable: true },
  },
  required: ["status", "error"],
} as const;

export async function playbackRoutes(app: FastifyInstance) {
  app.addSchema(streamSessionSchema);
  app.addSchema(streamStatusSchema);

  app.post<{ Params: { id: string }; Body: { channelId: string } }>(
    "/providers/:id/live/stream",
    {
      schema: {
        tags: ["playback"],
        summary: "Start an HLS playback session for a channel",
        description: "Blocks until the stream has actually started (or failed) — the returned playlistUrl is ready to play immediately, no client-side retry needed for the first load.",
        body: startStreamBodySchema,
        response: { 201: { $ref: "StreamSession#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      try {
        const result = await startSession(Number(request.params.id), request.body.channelId);
        reply.code(201);
        return result;
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/stream/:sessionId/status",
    {
      schema: {
        tags: ["playback"],
        summary: "Get a playback session's status",
        response: { 200: { $ref: "StreamStatus#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const status = getSessionStatus(request.params.sessionId);
      if (!status) return reply.code(404).send({ error: "session not found" });
      return status;
    },
  );

  app.get<{ Params: { sessionId: string; filename: string } }>(
    "/stream/:sessionId/:filename",
    {
      schema: {
        tags: ["playback"],
        summary: "Fetch a session's HLS playlist or segment file",
      },
    },
    async (request, reply) => {
      const filePath = getSessionFilePath(request.params.sessionId, request.params.filename);
      if (!filePath) return reply.code(404).send({ error: "not found" });
      touchSession(request.params.sessionId);
      try {
        const data = await readFile(filePath);
        reply.header("Content-Type", filePath.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
        reply.header("Cache-Control", "no-cache");
        return reply.send(data);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/stream/:sessionId",
    {
      schema: {
        tags: ["playback"],
        summary: "Stop a playback session",
        response: { 204: {} },
      },
    },
    async (request, reply) => {
      stopSession(request.params.sessionId, "stopped by client");
      reply.code(204).send();
    },
  );
}
