import type { FastifyInstance, FastifyReply } from "fastify";
import * as recorder from "../recorderClient.js";
import { RecorderNotConfiguredError, RecorderApiError } from "../recorderClient.js";
import { startSession } from "../playback/hlsSession.js";

// PLAN.md "Recording support" — recording itself is entirely iptv-recorder's
// job (storage, retention, the scheduler/worker that actually runs ffmpeg
// against a channel). This app is purely a client of iptv-recorder's own
// /recordings API (mirrors Laomedeia's electron/recorder.ts, adapted from
// IPC-shaped functions to a plain REST proxy) — every route here except
// POST /recordings/:id/stream is a thin passthrough. That one exception is
// this app's own addition: iptv-recorder serves a finished recording as a
// single raw MPEG-TS file over HTTP, which no browser can play directly (the
// same reason live channels go through ffmpeg->HLS instead of a raw
// passthrough, see ../playback/hlsSession.ts) — so playback remuxes it
// through the same HLS pipeline used for everything else, with the
// recording's authenticated file URL as ffmpeg's input.
//
// Only available when providerSourceConfig.mode = 'recorder' — there is no
// such thing as "local" recording, since iptv-recorder itself IS the
// recorder. RecorderNotConfiguredError (thrown by every recorderClient.ts
// call when unconfigured) already gates this correctly with no extra check
// needed: local mode never has a recorder connection to be configured with.

const recurrenceSchema = {
  type: "object",
  required: ["daysOfWeek", "startMinuteOfDay", "durationMinutes"],
  properties: {
    daysOfWeek: { type: "integer", minimum: 1, maximum: 127 },
    startMinuteOfDay: { type: "integer", minimum: 0, maximum: 1439 },
    durationMinutes: { type: "integer", minimum: 1 },
    endDate: { type: "string", minLength: 1 },
    maxOccurrences: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

const createBodySchema = {
  type: "object",
  required: ["providerId", "channelId"],
  properties: {
    providerId: { type: "integer" },
    channelId: { type: "string", minLength: 1 },
    startTime: { type: "string", minLength: 1 },
    endTime: { type: "string", minLength: 1 },
    recurrence: recurrenceSchema,
  },
  additionalProperties: false,
} as const;

const listQuerySchema = {
  type: "object",
  properties: {
    providerId: { type: "integer" },
    channelId: { type: "string" },
    status: { type: "string", enum: ["scheduled", "recording", "completed", "failed", "cancelled"] },
    startAfter: { type: "string" },
    startBefore: { type: "string" },
    recurringRuleId: { type: "integer" },
    includeProjected: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const recurringListQuerySchema = {
  type: "object",
  properties: {
    providerId: { type: "integer" },
    cancelled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const skipBodySchema = {
  type: "object",
  required: ["date"],
  properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
  additionalProperties: false,
} as const;

type CreateBody = {
  providerId: number;
  channelId: string;
  startTime?: string;
  endTime?: string;
  recurrence?: recorder.RecurrencePattern;
};

// Every route here talks to a sibling service over the network — translate
// its failure modes the same way everywhere: "not configured" is a
// client-fixable 400, iptv-recorder's own status (its 409 hard-rejects carry
// the real reason: disabled provider, storage exhaustion, concurrent-stream/
// same-channel conflicts) passes straight through, anything else is an
// unexpected 502 (the recorder itself is reachable-but-broken, or
// unreachable).
function sendRecorderError(reply: FastifyReply, err: unknown) {
  if (err instanceof RecorderNotConfiguredError) {
    return reply.code(400).send({ error: "Recording requires recorder mode — this app has no recording capability of its own; iptv-recorder provides it." });
  }
  if (err instanceof RecorderApiError) {
    return reply.code(err.status).send({ error: err.message });
  }
  return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
}

export async function recordingRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateBody }>(
    "/recordings",
    {
      schema: {
        tags: ["recordings"],
        summary: "Schedule a recording (one-off or recurring)",
        description: "Proxies iptv-recorder's own POST /recordings. Exactly one of startTime/endTime or recurrence must be given.",
        body: createBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const body = request.body;
        const result = body.recurrence
          ? await recorder.createRecurringRecording({ providerId: body.providerId, channelId: body.channelId, recurrence: body.recurrence })
          : await recorder.createOneOffRecording({ providerId: body.providerId, channelId: body.channelId, startTime: body.startTime!, endTime: body.endTime! });
        reply.code(201);
        return result;
      } catch (err) {
        return sendRecorderError(reply, err);
      }
    },
  );

  app.get<{ Querystring: recorder.RecordingsFilter }>(
    "/recordings",
    { schema: { tags: ["recordings"], summary: "List/filter recordings", querystring: listQuerySchema } },
    async (request, reply) => {
      try {
        return await recorder.listRecordings(request.query);
      } catch (err) {
        return sendRecorderError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/recordings/:id", { schema: { tags: ["recordings"], summary: "Get a recording" } }, async (request, reply) => {
    try {
      return await recorder.getRecording(Number(request.params.id));
    } catch (err) {
      return sendRecorderError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/recordings/:id",
    { schema: { tags: ["recordings"], summary: "Cancel a scheduled/in-progress recording, or delete a finished one" } },
    async (request, reply) => {
      try {
        await recorder.cancelRecording(Number(request.params.id));
        reply.code(204).send();
      } catch (err) {
        sendRecorderError(reply, err);
      }
    },
  );

  app.get<{ Querystring: recorder.RecurringRulesFilter }>(
    "/recordings/recurring",
    { schema: { tags: ["recordings"], summary: "List recurring recording rules", querystring: recurringListQuerySchema } },
    async (request, reply) => {
      try {
        return await recorder.listRecurringRules(request.query);
      } catch (err) {
        return sendRecorderError(reply, err);
      }
    },
  );

  app.delete<{ Params: { ruleId: string } }>(
    "/recordings/recurring/:ruleId",
    { schema: { tags: ["recordings"], summary: "Cancel a recurring rule" } },
    async (request, reply) => {
      try {
        return await recorder.cancelRecurringRule(Number(request.params.ruleId));
      } catch (err) {
        return sendRecorderError(reply, err);
      }
    },
  );

  app.post<{ Params: { ruleId: string }; Body: { date: string } }>(
    "/recordings/recurring/:ruleId/skip",
    { schema: { tags: ["recordings"], summary: "Skip a single occurrence of a recurring rule", body: skipBodySchema } },
    async (request, reply) => {
      try {
        return await recorder.skipOccurrence(Number(request.params.ruleId), request.body.date);
      } catch (err) {
        return sendRecorderError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/recordings/:id/stream",
    {
      schema: {
        tags: ["recordings"],
        summary: "Start an HLS playback session for a completed recording",
        description: "Remuxes iptv-recorder's raw MPEG-TS file through ffmpeg into browser-playable HLS, same pipeline as live/VOD playback (../playback/hlsSession.ts). Blocks until ready, same as the other stream-start endpoints.",
      },
    },
    async (request, reply) => {
      try {
        const id = Number(request.params.id);
        const recording = await recorder.getRecording(id);
        if (recording.status !== "completed" || !recording.filePath) {
          return reply.code(409).send({ error: "recording is not ready to play (not completed, or its file was removed by retention)" });
        }
        const { url, headers } = recorder.getRecordingStreamSource(id);
        const result = await startSession({
          providerId: recording.providerId,
          mediaId: `recording-${id}`,
          streamUrl: url,
          kind: "vod",
          codecCacheKey: `recording-${id}`,
          headers,
        });
        reply.code(201);
        return result;
      } catch (err) {
        return sendRecorderError(reply, err);
      }
    },
  );
}
