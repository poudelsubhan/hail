import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { dao, type UserRow } from "./db/index.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
  }
}

/**
 * Paths that NEVER require auth. Everything else: optional auth on GET (attach
 * req.user if a key is present), required auth on mutating verbs.
 */
const PUBLIC_PATHS = new Set<string>([
  "/health",
  "/ws",
  "/signup",
]);

const READONLY_PUBLIC_PREFIXES = [
  "/registry/lookup",
  "/registry/agents",
  "/jobs", // GET /jobs/:id is public for dashboard polling
  "/capabilities",
  "/spend",
  "/metrics",
  "/wallets", // GET only — POST /wallets/:id/fund still requires auth
];

function isReadonlyPublic(method: string, url: string): boolean {
  if (method !== "GET") return false;
  return READONLY_PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"));
}

export function extractApiKey(req: FastifyRequest): string | undefined {
  const h = req.headers["authorization"];
  if (!h || typeof h !== "string") return undefined;
  if (!h.startsWith("Bearer ")) return undefined;
  return h.slice("Bearer ".length).trim();
}

export async function registerAuth(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? "";

    // Always-public
    if (PUBLIC_PATHS.has(url)) return;

    const apiKey = extractApiKey(req);
    if (apiKey) {
      const user = dao.findUserByApiKey(apiKey);
      if (user) req.user = user;
    }

    // Read-only endpoints: never require auth; req.user is best-effort.
    if (isReadonlyPublic(req.method, url)) return;

    // Telemetry endpoint: anonymous agents can still post LLM cost events.
    if (url === "/telemetry/llm-cost") return;

    // Anything else mutating requires a user.
    if (req.method === "GET") return; // be permissive for unspecified GETs
    if (!req.user) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
}
