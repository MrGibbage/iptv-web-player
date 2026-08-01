import "dotenv/config";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { db } from "./db/client.js";
import { configRoutes } from "./routes/config.js";
import { providerRoutes } from "./routes/providers.js";
import { epgRoutes } from "./routes/epg.js";
import { liveRoutes } from "./routes/live.js";
import { vodRoutes } from "./routes/vod.js";
import { seriesRoutes } from "./routes/series.js";
import { progressRoutes } from "./routes/progress.js";
import { playbackRoutes } from "./routes/playback.js";
import { statsRoutes } from "./routes/stats.js";
import { startEpgRefresh, stopEpgRefresh } from "./epg/index.js";
import { startHlsSweep, stopHlsSweep, stopAllSessions } from "./playback/hlsSession.js";
import { log } from "./logger.js";

const app = Fastify({ logger: true });

// Mirrors iptv-recorder/iptv-scheduler's own Swagger setup exactly, minus
// any auth/security block — this app has no auth at all (single-user,
// LAN-only decision, see PLAN.md).
await app.register(swagger, {
  openapi: {
    info: {
      title: "iptv-web-player API",
      description: "Live TV / EPG / VOD / Series web player backend. See PLAN.md in the repo for design rationale.",
      version: "0.1.0",
    },
  },
  refResolver: {
    buildLocalReference(json: { $id?: string }, _baseUri: unknown, _fragment: unknown, i: number) {
      return json.$id ?? `def-${i}`;
    },
  },
});
await app.register(swaggerUi, { routePrefix: "/documentation" });

app.addSchema({
  $id: "Error",
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
});

app.get("/health", { schema: { tags: ["health"], summary: "Liveness check" } }, async () => {
  return { status: "ok" };
});

app.get("/health/db", { schema: { tags: ["health"], summary: "DB connectivity check" } }, async () => {
  db.$client.pragma("journal_mode");
  return { status: "ok" };
});

await app.register(configRoutes);
await app.register(providerRoutes);
await app.register(epgRoutes);
await app.register(liveRoutes);
await app.register(vodRoutes);
await app.register(seriesRoutes);
await app.register(progressRoutes);
await app.register(playbackRoutes);
await app.register(statsRoutes);

app.addHook("onClose", async () => {
  stopEpgRefresh();
  stopHlsSweep();
  stopAllSessions();
});

// Playback sessions spawn real ffmpeg child processes, not just timers —
// an orphaned one keeps pulling from the provider and burning CPU
// indefinitely, not just idling. Fastify's onClose only runs for a graceful
// app.close(); it does NOT run automatically on SIGTERM/SIGINT (e.g. `tsx
// watch` restarting this process on every file save during dev), so those
// need their own explicit handlers or every hot-reload leaks an ffmpeg
// process. Found and fixed a real instance of exactly this class of bug
// earlier in this project (orphaned tsx watch supervisors, no child
// processes involved that time) — this is the same risk with a much more
// expensive orphan.
function shutdown() {
  log("shutdown", "signal received, stopping sessions");
  stopHlsSweep();
  stopAllSessions();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const port = Number(process.env.PORT ?? 4300);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

startEpgRefresh();
startHlsSweep();
