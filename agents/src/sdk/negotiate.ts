import { chat as directChat } from "@ac/llm";

/**
 * Claude-powered bid proposer. Routes through the coordinator's host-paid
 * `/llm/chat` proxy when configured (default), or falls back to a direct
 * @ac/llm call using the participant's own ANTHROPIC_API_KEY.
 *
 * Returns null when Claude refuses or the response can't be parsed. Cheap by
 * design: Haiku 4.5, capped at 128 max tokens.
 */

export interface ProposalInput {
  agentUri: string;
  role: string;
  capability: string;
  brief: string;
  maxPriceUsd: number;
  competingBids?: { priceUsd: number; etaSec: number }[];
  /** When provided, bid proposals route through the host-paid proxy. Without
   *  it, calls hit Anthropic directly via @ac/llm (participant pays). */
  apiKey?: string;
  coordUrl?: string;
}

export interface Proposal {
  priceUsd: number;
  etaSec: number;
  note: string;
}

const SYSTEM_TEMPLATE = (role: string) => `You are a Claude-powered marketplace agent placing a bid.
Personality: ${role}.
Goal: win profitable work; refuse jobs that look like a trap.
Output STRICT JSON only, no prose. Schema:
{"priceUsd": number, "etaSec": number, "note": string}
- priceUsd <= maxPriceUsd
- etaSec is realistic for the brief
- note is one short sentence (max 80 chars) explaining your pricing`;

interface ProxyResponse {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  costUsd: number;
  latencyMs: number;
}

async function proxyChat(opts: {
  apiKey: string;
  coordUrl: string;
  system: string;
  user: string;
  agentUri: string;
}): Promise<string | null> {
  try {
    const res = await fetch(`${opts.coordUrl}/llm/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        cacheSystem: true,
        agentUri: opts.agentUri,
        tag: "bid",
        maxTokens: 128,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      process.stderr.write(`[negotiate] proxy /llm/chat -> ${res.status}: ${await res.text()}\n`);
      return null;
    }
    const j = (await res.json()) as ProxyResponse;
    return j.text;
  } catch (e) {
    process.stderr.write(`[negotiate] proxy chat failed: ${(e as Error).message}\n`);
    return null;
  }
}

export async function proposeBid(opts: ProposalInput): Promise<Proposal | null> {
  const system = SYSTEM_TEMPLATE(opts.role);
  const competing = opts.competingBids?.length
    ? `\nCompeting bids so far: ${JSON.stringify(opts.competingBids)}`
    : "";
  const user = `Capability: ${opts.capability}
Max price USD: ${opts.maxPriceUsd}
Brief: ${opts.brief}${competing}

Return your bid as JSON.`;

  let text: string | null = null;
  const apiKey = opts.apiKey ?? process.env.AC_API_KEY ?? process.env.AC_HOST_API_KEY;
  const coordUrl = opts.coordUrl ?? process.env.COORDINATOR_URL ?? "http://localhost:8787";

  if (apiKey) {
    text = await proxyChat({ apiKey, coordUrl, system, user, agentUri: opts.agentUri });
  }
  if (text === null) {
    // Fall back to a direct call so participants without proxy creds (or when
    // the proxy is rate-capped) still get a bid.
    try {
      const r = await directChat({
        system,
        messages: [{ role: "user", content: user }],
        cacheSystem: true,
        agentUri: opts.agentUri,
        tag: "bid",
        maxTokens: 128,
        temperature: 0.3,
      });
      text = r.text;
    } catch (e) {
      process.stderr.write(`[negotiate] direct chat fallback failed: ${(e as Error).message}\n`);
      return null;
    }
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<Proposal>;
    if (typeof parsed.priceUsd !== "number" || typeof parsed.etaSec !== "number") {
      return null;
    }
    const note = typeof parsed.note === "string" ? parsed.note : "";
    return {
      priceUsd: Math.min(parsed.priceUsd, opts.maxPriceUsd),
      etaSec: Math.max(1, Math.min(parsed.etaSec, 120)),
      note: note.slice(0, 120),
    };
  } catch {
    return null;
  }
}
