import "dotenv/config";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { db } from "./db/client.js";
import { configRoutes } from "./routes/config.js";
import { providerRoutes } from "./routes/providers.js";
import { epgRoutes } from "./routes/epg.js";
import { startEpgRefresh, stopEpgRefresh } from "./epg/index.js";

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

app.addHook("onClose", async () => {
  stopEpgRefresh();
});

const port = Number(process.env.PORT ?? 4300);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

startEpgRefresh();
