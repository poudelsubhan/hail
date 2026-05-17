import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Walk up from this file to find the nearest `.env` (workspace root). Without
 * this, `dotenv/config` only checks process.cwd(), so `pnpm --filter foo exec`
 * runs miss the root .env.
 */
function loadRootEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to default behavior so users aren't blocked if they put .env
  // somewhere unusual.
  dotenv.config();
}
loadRootEnv();

/**
 * Single Claude entry point for the whole repo. Every agent + the coordinator
 * route Claude calls through here so the dashboard's cost panel is the truth.
 *
 * Hackathon defaults: low temperature, hard max_tokens cap, prompt caching ON
 * for system+tools so we don't burn tokens re-sending the same context.
 */

export type ClaudeModel =
  | "claude-haiku-4-5"
  | "claude-sonnet-4-6"
  | "claude-opus-4-7";

const DEFAULT_MODEL: ClaudeModel = "claude-haiku-4-5";

// USD per million tokens. Update when pricing changes — sourced from
// anthropic.com/pricing. Cache reads ~10% of input; cache writes ~125%.
const PRICE_PER_MTOK: Record<
  ClaudeModel,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-7": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
};

export interface ClaudeCallLog {
  model: ClaudeModel;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
  promptHash: string;
  agentUri?: string;
  ts: number;
}

export type LogSink = (log: ClaudeCallLog) => void;
let logSink: LogSink = (log) => {
  // Default: pretty stderr line. Wrappers replace this to forward to WS bus.
  process.stderr.write(
    `[claude] model=${log.model} in=${log.inputTokens} out=${log.outputTokens} ` +
      `cacheR=${log.cacheReadTokens} cacheW=${log.cacheWriteTokens} ` +
      `cost=$${log.costUsd.toFixed(6)} ${log.latencyMs}ms hash=${log.promptHash.slice(0, 8)}\n`,
  );
};

export function setClaudeLogSink(sink: LogSink) {
  logSink = sink;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing — populate .env from .env.example");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export interface ChatOpts {
  model?: ClaudeModel;
  system?: string;
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  temperature?: number;
  /** Apply ephemeral cache_control to system block (good for stable prompts). */
  cacheSystem?: boolean;
  /** For attribution in the dashboard. */
  agentUri?: string;
  /** Optional tag for grouping logs (e.g., "negotiation", "summarize"). */
  tag?: string;
}

export interface ChatResult {
  text: string;
  raw: Anthropic.Message;
  log: ClaudeCallLog;
}

/**
 * Single-turn convenience wrapper. Caps max_tokens, low temp by default,
 * caches the system block when asked. Logs cost + latency to the sink.
 */
export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 512;
  const temperature = opts.temperature ?? 0.2;

  const promptHash = createHash("sha256")
    .update(JSON.stringify({ system: opts.system, messages: opts.messages }))
    .digest("hex");

  const system = opts.system
    ? opts.cacheSystem
      ? [
          {
            type: "text" as const,
            text: opts.system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : opts.system
    : undefined;

  const t0 = performance.now();
  const raw = await client().messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: opts.messages,
  });
  const latencyMs = Math.round(performance.now() - t0);

  const usage = raw.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens =
    (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const cacheWriteTokens =
    (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;

  const price = PRICE_PER_MTOK[model];
  const costUsd =
    (inputTokens * price.input +
      outputTokens * price.output +
      cacheReadTokens * price.cacheRead +
      cacheWriteTokens * price.cacheWrite) /
    1_000_000;

  const log: ClaudeCallLog = {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    latencyMs,
    promptHash,
    agentUri: opts.agentUri,
    ts: Date.now(),
  };
  logSink(log);

  const text = raw.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return { text, raw, log };
}
