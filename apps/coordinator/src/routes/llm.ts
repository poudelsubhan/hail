import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chat, type ClaudeModel } from "@ac/llm";
import { dao } from "../db/index.js";
import { bus } from "../bus.js";
import { store } from "../store.js";

/**
 * Host-paid Claude proxy. Participants who want host-floated LLM credit hit
 * this endpoint with their apiKey; we charge a daily token cap per user and
 * persist every call to `llm_costs`. Participants who would rather use their
 * own ANTHROPIC_API_KEY can skip this entirely and call @ac/llm directly.
 */

const ALLOWED_MODELS: ReadonlySet<ClaudeModel> = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
]);

const MAX_TOKENS_CAP = 1024;
const DAILY_INPUT_TOK_CAP = Number(process.env.AC_DAILY_TOKEN_CAP_IN ?? "100000");
const DAILY_OUTPUT_TOK_CAP = Number(process.env.AC_DAILY_TOKEN_CAP_OUT ?? "25000");

const Message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const ChatReq = z.object({
  system: z.string().optional(),
  messages: z.array(Message).min(1),
  model: z.enum(["claude-haiku-4-5", "claude-sonnet-4-6"]).optional(),
  maxTokens: z.number().int().positive().max(MAX_TOKENS_CAP).optional(),
  temperature: z.number().min(0).max(1).optional(),
  cacheSystem: z.boolean().optional(),
  agentUri: z.string().optional(),
  tag: z.string().optional(),
});

function startOfUtcDay(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function llmRoutes(app: FastifyInstance) {
  app.post("/llm/chat", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = ChatReq.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { system, messages, model, maxTokens, temperature, cacheSystem, agentUri, tag } = parsed.data;

    if (model && !ALLOWED_MODELS.has(model)) {
      return reply.code(400).send({ error: "model_not_allowed", allowed: [...ALLOWED_MODELS] });
    }

    // Daily token cap — sum input + output separately since prices differ.
    const since = startOfUtcDay();
    const usedToday = dao.llmTokensByUserSince(req.user.id, since);
    if (usedToday.input_tokens >= DAILY_INPUT_TOK_CAP) {
      return reply.code(429).send({
        error: "daily_token_cap_exceeded",
        kind: "input",
        usedInputTokens: usedToday.input_tokens,
        capInputTokens: DAILY_INPUT_TOK_CAP,
      });
    }
    if (usedToday.output_tokens >= DAILY_OUTPUT_TOK_CAP) {
      return reply.code(429).send({
        error: "daily_token_cap_exceeded",
        kind: "output",
        usedOutputTokens: usedToday.output_tokens,
        capOutputTokens: DAILY_OUTPUT_TOK_CAP,
      });
    }

    let result;
    try {
      result = await chat({
        system,
        messages,
        model,
        maxTokens: Math.min(maxTokens ?? 512, MAX_TOKENS_CAP),
        temperature,
        cacheSystem,
        agentUri,
        tag,
      });
    } catch (e) {
      req.log.error({ err: e }, "llm proxy upstream failed");
      return reply.code(502).send({ error: "upstream_failed", detail: (e as Error).message });
    }

    const { log } = result;

    // Persist for cost rollup + cap enforcement on the next call.
    dao.insertLlmCost({
      user_id: req.user.id,
      model: log.model,
      input_tokens: log.inputTokens,
      output_tokens: log.outputTokens,
      cost_usd: log.costUsd,
      ts: log.ts,
    });

    // Mirror to the WS bus so the dashboard's existing llm.cost panel works
    // unchanged. agentUri carries the *caller's* tag when provided.
    bus.publish({
      type: "llm.cost",
      agentUri: agentUri as `agent://${string}.local` | undefined,
      model: log.model,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      cacheReadTokens: log.cacheReadTokens,
      cacheWriteTokens: log.cacheWriteTokens,
      costUsd: log.costUsd,
      latencyMs: log.latencyMs,
      promptHash: log.promptHash,
      ts: log.ts,
    });
    store.recordLlmSpend(log.costUsd, agentUri as `agent://${string}.local` | undefined);

    return {
      text: result.text,
      usage: {
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        cacheReadTokens: log.cacheReadTokens,
        cacheWriteTokens: log.cacheWriteTokens,
      },
      costUsd: log.costUsd,
      latencyMs: log.latencyMs,
    };
  });

  app.get("/llm/quota", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const since = startOfUtcDay();
    const used = dao.llmTokensByUserSince(req.user.id, since);
    return {
      usedInputTokens: used.input_tokens,
      usedOutputTokens: used.output_tokens,
      capInputTokens: DAILY_INPUT_TOK_CAP,
      capOutputTokens: DAILY_OUTPUT_TOK_CAP,
      windowStartTs: since,
    };
  });
}
