import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers } from "../db/schema.js";
import { encrypt } from "../crypto.js";
import { checkXtreamAuth, checkM3uPlaylist } from "../worker/xtreamAuth.js";

// This app's own provider store — only meaningful when
// providerSourceConfig.mode = 'local' (see ../db/schema.ts and
// ../providerSource.ts). Routes stay registered regardless of the current
// mode, so switching back to 'local' later doesn't need a redeploy.
// type is immutable after creation (see updateBodySchema — it has no
// `type` property): converting an existing Xtream provider into an M3U one
// isn't a real workflow. Delete/recreate covers the rare case where a
// provider genuinely switches shape.

const createBodySchema = {
  type: "object",
  required: ["name", "type"],
  properties: {
    name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    playlistUrl: { type: "string", minLength: 1 },
    epgUrl: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
  },
  allOf: [
    { if: { properties: { type: { const: "xtream" } } }, then: { required: ["baseUrl", "username", "password"] } },
    { if: { properties: { type: { const: "m3u" } } }, then: { required: ["playlistUrl"] } },
  ],
  additionalProperties: false,
} as const;

const updateBodySchema = {
  type: "object",
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1 },
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    playlistUrl: { type: "string", minLength: 1 },
    epgUrl: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type CreateBody = {
  name: string;
  type: "xtream" | "m3u";
  baseUrl?: string;
  username?: string;
  password?: string;
  playlistUrl?: string;
  epgUrl?: string;
  enabled?: boolean;
};

type UpdateBody = {
  name?: string;
  baseUrl?: string;
  username?: string;
  password?: string;
  playlistUrl?: string;
  epgUrl?: string;
  enabled?: boolean;
};

const testBodySchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    playlistUrl: { type: "string", minLength: 1 },
  },
  allOf: [
    { if: { properties: { type: { const: "xtream" } } }, then: { required: ["baseUrl", "username", "password"] } },
    { if: { properties: { type: { const: "m3u" } } }, then: { required: ["playlistUrl"] } },
  ],
  additionalProperties: false,
} as const;

type TestBody = { type: "xtream"; baseUrl: string; username: string; password: string } | { type: "m3u"; playlistUrl: string };

// Credentials (username/password/playlistUrl/epgUrl) are intentionally
// absent — see redact() below, never returned in any response.
const providerSchema = {
  $id: "Provider",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: ["string", "null"] },
    enabled: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "type", "baseUrl", "enabled", "createdAt", "updatedAt"],
} as const;

const authCheckResultSchema = {
  $id: "AuthCheckResult",
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string", description: "Present only when ok is false." },
    checkedAt: { type: "string", format: "date-time" },
  },
  required: ["ok", "checkedAt"],
} as const;

// Credentials never leave this module in plaintext or ciphertext form —
// every response is redacted down to what a client is allowed to see.
function redact(provider: typeof providers.$inferSelect) {
  const { usernameEncrypted, passwordEncrypted, playlistUrlEncrypted, epgUrlEncrypted, ...rest } = provider;
  return rest;
}

export async function providerRoutes(app: FastifyInstance) {
  app.addSchema(providerSchema);
  app.addSchema(authCheckResultSchema);

  app.post<{ Body: CreateBody }>(
    "/providers",
    {
      schema: {
        tags: ["providers"],
        summary: "Add a local provider",
        body: createBodySchema,
        response: { 201: { $ref: "Provider#" } },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const [created] = db
        .insert(providers)
        .values(
          body.type === "xtream"
            ? {
                name: body.name,
                type: "xtream",
                // Schema's allOf/if/then already guarantees these are
                // present when type = "xtream" (see createBodySchema).
                baseUrl: body.baseUrl!,
                usernameEncrypted: encrypt(body.username!),
                passwordEncrypted: encrypt(body.password!),
                enabled: body.enabled ?? true,
              }
            : {
                name: body.name,
                type: "m3u",
                playlistUrlEncrypted: encrypt(body.playlistUrl!),
                epgUrlEncrypted: body.epgUrl ? encrypt(body.epgUrl) : null,
                enabled: body.enabled ?? true,
              },
        )
        .returning()
        .all();
      reply.code(201);
      return redact(created);
    },
  );

  // Tests credentials before they're ever saved — lets the Settings UI gate
  // its "Add provider" save button on a passing test, without needing a
  // provider row (and its id) to already exist. Never touches the
  // database; the credentials are only ever held in memory for the
  // duration of the request.
  app.post<{ Body: TestBody }>(
    "/providers/test",
    {
      schema: {
        tags: ["providers"],
        summary: "Test provider credentials",
        description: "Live auth check against the given credentials, without creating or storing a provider.",
        body: testBodySchema,
        response: { 200: { $ref: "AuthCheckResult#" } },
      },
    },
    async (request) => {
      const body = request.body;
      const auth = body.type === "xtream" ? await checkXtreamAuth(body) : await checkM3uPlaylist(body.playlistUrl);
      return { ...auth, checkedAt: new Date().toISOString() };
    },
  );

  app.get(
    "/providers",
    {
      schema: {
        tags: ["providers"],
        summary: "List local providers",
        response: { 200: { type: "array", items: { $ref: "Provider#" } } },
      },
    },
    async () => {
      return db.select().from(providers).all().map(redact);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Get a local provider",
        response: { 200: { $ref: "Provider#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [row] = db.select().from(providers).where(eq(providers.id, id)).all();
      if (!row) {
        return reply.code(404).send({ error: "provider not found" });
      }
      return redact(row);
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateBody }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Update a local provider",
        description: "type is immutable — the body has no type field, only the fields belonging to the provider's existing type are accepted.",
        body: updateBodySchema,
        response: { 200: { $ref: "Provider#" }, 400: { $ref: "Error#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [existing] = db.select().from(providers).where(eq(providers.id, id)).all();
      if (!existing) {
        return reply.code(404).send({ error: "provider not found" });
      }

      const body = request.body;
      if (existing.type === "xtream" && (body.playlistUrl !== undefined || body.epgUrl !== undefined)) {
        return reply.code(400).send({ error: "playlistUrl/epgUrl only apply to m3u providers" });
      }
      if (existing.type === "m3u" && (body.baseUrl !== undefined || body.username !== undefined || body.password !== undefined)) {
        return reply.code(400).send({ error: "baseUrl/username/password only apply to xtream providers" });
      }

      const updates: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (existing.type === "xtream") {
        if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
        if (body.username !== undefined) updates.usernameEncrypted = encrypt(body.username);
        if (body.password !== undefined) updates.passwordEncrypted = encrypt(body.password);
      } else {
        if (body.playlistUrl !== undefined) updates.playlistUrlEncrypted = encrypt(body.playlistUrl);
        if (body.epgUrl !== undefined) updates.epgUrlEncrypted = body.epgUrl ? encrypt(body.epgUrl) : null;
      }

      const [updated] = db.update(providers).set(updates).where(eq(providers.id, id)).returning().all();
      return redact(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Delete a local provider",
        response: { 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [existing] = db.select().from(providers).where(eq(providers.id, id)).all();
      if (!existing) {
        return reply.code(404).send({ error: "provider not found" });
      }
      db.delete(providers).where(eq(providers.id, id)).run();
      reply.code(204).send();
    },
  );
}
