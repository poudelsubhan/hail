import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentUri } from "@ac/contracts";
import { bus } from "../bus.js";

const Body = z.object({
  jobId: z.string(),
  from: AgentUri,
  to: AgentUri,
  round: z.number().int().min(1).default(1),
  proposal: z.object({
    priceUsd: z.number().nonnegative(),
    etaSec: z.number().nonnegative(),
    scopeCaveats: z.array(z.string()).optional(),
  }),
});

/**
 * Lets agents broadcast a `negotiation.message` WS event. Useful for drama
 * (Skeptic chiming in during scenario 3) and for any back-and-forth that
 * isn't already captured by job.posted / bid.placed.
 */
export async function negotiationRoutes(app: FastifyInstance) {
  app.post("/negotiation/message", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    bus.publish({
      type: "negotiation.message",
      jobId: d.jobId,
      from: d.from,
      to: d.to,
      round: d.round,
      proposal: d.proposal,
      ts: Date.now(),
    });
    return { ok: true };
  });
}
