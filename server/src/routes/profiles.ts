import type { FastifyInstance } from "fastify";
import { listProfiles } from "../recorderClient.js";

const profileSchema = {
  $id: "Profile",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "createdAt"],
} as const;

// PLAN.md "Profiles" — read-only proxy of iptv-recorder's own GET /profiles,
// just enough to populate a "who's watching" picker (see localSettings.ts's
// current-profile persistence and the Guide/nav hamburgers' own selects).
// Creating and deleting profiles stays iptv-recorder's own job, reachable
// via the Recordings screen's "Open Recorder" link — this app doesn't
// re-implement that admin surface, same stance as /config/recorder/providers.
export async function profileRoutes(app: FastifyInstance) {
  app.addSchema(profileSchema);

  app.get(
    "/profiles",
    {
      schema: {
        tags: ["profiles"],
        summary: "List iptv-recorder's profiles",
        description: "Proxies iptv-recorder's GET /profiles. Requires /config/recorder to already be configured.",
        response: { 200: { type: "array", items: { $ref: "Profile#" } }, 400: { $ref: "Error#" } },
      },
    },
    async (_request, reply) => {
      try {
        return await listProfiles();
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
