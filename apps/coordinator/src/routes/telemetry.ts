import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentUri } from "@ac/contracts";
import { store } from "../store.js";
import { bus } from "../bus.js";

const LlmCostReport = z.object({
  agentUri: AgentUri.optional(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional().default(0),
  cacheWriteTokens: z.number().optional().default(0),
  costUsd: z.number(),
  latencyMs: z.number(),
  promptHash: z.string(),
});

/**
 * /telemetry/llm-cost — agents in their own process POST every Claude call
 * here so the dashboard sees ALL LLM spend, not just calls made inside the
 * coordinator. Without this the per-agent spend panel will undercount.
 */
export async function telemetryRoutes(app: FastifyInstance) {
  app.post("/telemetry/llm-cost", async (req, reply) => {
    const parsed = LlmCostReport.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    store.recordLlmSpend(d.costUsd, d.agentUri);
    bus.publish({
      type: "llm.cost",
      agentUri: d.agentUri,
      model: d.model,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      cacheWriteTokens: d.cacheWriteTokens,
      costUsd: d.costUsd,
      latencyMs: d.latencyMs,
      promptHash: d.promptHash,
      ts: Date.now(),
    });
    return { ok: true };
  });
}
