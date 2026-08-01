import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { listSessionStats, listOrphanedSessionDirs } from "../playback/hlsSession.js";
import { getLogFilePaths } from "../logger.js";

// "Stats for nerds" (PLAN.md) — ported conceptually from Laomedeia's own
// diagnostics panel. Read-only, no auth (matches the rest of this app,
// PLAN.md "Credentials Model" — single-user, LAN-only). Two purposes: (1) a
// live look at what ffmpeg is doing per active session, since that's
// otherwise invisible once the HLS/Player UI is happily playing; (2) a
// direct answer to the open "orphaned sessions" question — a segment
// directory left on disk with no tracked session pointing at it is the
// clearest available signal of session-map loss (dev restart, crash), since
// this process has no other record of what it used to be tracking.

const sessionStatsSchema = {
  $id: "SessionStats",
  type: "object",
  properties: {
    id: { type: "string" },
    providerId: { type: "integer" },
    mediaId: { type: "string" },
    kind: { type: "string", enum: ["live", "vod"] },
    status: { type: "string", enum: ["starting", "running", "error"] },
    error: { type: "string", nullable: true },
    pid: { type: "integer", nullable: true },
    ageSecs: { type: "integer" },
    idleSecs: { type: "integer" },
    videoPassthrough: { type: "boolean" },
    audioPassthrough: { type: "boolean" },
  },
  required: ["id", "providerId", "mediaId", "kind", "status", "error", "pid", "ageSecs", "idleSecs", "videoPassthrough", "audioPassthrough"],
} as const;

const statsSchema = {
  $id: "Stats",
  type: "object",
  properties: {
    uptimeSecs: { type: "integer" },
    rssBytes: { type: "integer" },
    heapUsedBytes: { type: "integer" },
    sessions: { type: "array", items: { $ref: "SessionStats#" } },
    orphanedSessionDirs: { type: "array", items: { type: "string" } },
  },
  required: ["uptimeSecs", "rssBytes", "heapUsedBytes", "sessions", "orphanedSessionDirs"],
} as const;

export async function statsRoutes(app: FastifyInstance) {
  app.addSchema(sessionStatsSchema);
  app.addSchema(statsSchema);

  app.get(
    "/stats",
    {
      schema: {
        tags: ["stats"],
        summary: "Server + active-session diagnostics ('stats for nerds')",
        response: { 200: { $ref: "Stats#" } },
      },
    },
    async () => {
      const mem = process.memoryUsage();
      return {
        uptimeSecs: Math.round(process.uptime()),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        sessions: listSessionStats(),
        orphanedSessionDirs: await listOrphanedSessionDirs(),
      };
    },
  );

  app.get(
    "/logs/download",
    {
      schema: {
        tags: ["stats"],
        summary: "Download the app log as a single text file",
        description: "Concatenates the rotated + current log file, oldest first — meant to be attached/pasted when reporting a problem (e.g. a family member hitting playback trouble and sending this back).",
      },
    },
    async (_request, reply) => {
      const parts = await Promise.all(
        getLogFilePaths().map((p) =>
          readFile(p, "utf-8").catch(() => ""),
        ),
      );
      const body = parts.filter(Boolean).join("");
      const filename = `iptv-web-player-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
      reply.header("Content-Type", "text/plain; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(body || "(no log output yet)");
    },
  );
}
