import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";

// PLAN.md "Docker deployment" — provider picons (channel logos, VOD/series
// posters) are served by the Xtream provider over plain HTTP. That was
// invisible while this app itself was also LAN http://, but became a real,
// visible mixed-content block the moment the app moved behind HTTPS
// (Caddy/Cloudflare Tunnel). Fetching the bytes here (server-side, no
// browser same-origin/mixed-content rules apply) and re-serving them over
// this app's own HTTPS origin is the same shape the playback pipeline
// already uses for video — the browser never talks to the provider
// directly for anything.
//
// This app has no auth at all (single-user, LAN-only-by-default decision,
// see PLAN.md), so this route — unlike everything else here, which only
// ever fetches whatever a pre-configured provider itself returned — accepts
// an arbitrary caller-supplied URL and has the server fetch it. That's a
// real, if modest, SSRF-style widening (a request from anywhere the app is
// reachable, e.g. the public Cloudflare Tunnel hostname, could otherwise
// make this server probe internal LAN/loopback addresses). Blocking the
// common private/loopback ranges by hostname pattern (not full DNS-rebind-
// proof, but proportionate to a homelab hobby project's actual threat
// model) is the mitigation; requiring the upstream response to actually be
// an image is the other half (this was never meant to be a general-purpose
// fetch proxy).
const PRIVATE_HOST_PATTERNS = [/^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^::1$/, /^0\.0\.0\.0$/];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(hostname));
}

const FETCH_TIMEOUT_MS = 10_000;

export async function imageProxyRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url?: string } }>(
    "/image-proxy",
    {
      schema: {
        tags: ["media"],
        summary: "Proxy a provider-hosted image over this app's own HTTPS origin",
        description: "Works around mixed-content blocking for provider picons served over plain HTTP — see the route's own source comment for the SSRF-widening tradeoff and its mitigations.",
        querystring: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string" } },
        },
        response: { 400: { $ref: "Error#" }, 502: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      let target: URL;
      try {
        target = new URL(request.query.url ?? "");
      } catch {
        return reply.code(400).send({ error: "invalid url" });
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return reply.code(400).send({ error: "unsupported protocol" });
      }
      if (isPrivateHost(target.hostname)) {
        return reply.code(400).send({ error: "refusing to proxy a private/loopback host" });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await fetch(target, { signal: controller.signal });
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        clearTimeout(timer);
      }

      if (!upstream.ok || !upstream.body) {
        return reply.code(502).send({ error: `upstream returned ${upstream.status}` });
      }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        return reply.code(502).send({ error: "upstream did not return an image" });
      }

      reply.header("content-type", contentType);
      // Picons rarely change — a day-long cache keeps repeat grid renders
      // (hundreds of channel rows) from re-fetching the same logo file.
      reply.header("cache-control", "public, max-age=86400");
      // TS sees global fetch's DOM-lib ReadableStream and node:stream/web's
      // ReadableStream as structurally distinct types (a known interop
      // wrinkle, not a real type mismatch) — Readable.fromWeb works fine at
      // runtime with either.
      return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
    },
  );
}
