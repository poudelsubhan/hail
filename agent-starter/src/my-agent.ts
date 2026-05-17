/**
 * Agent starter — copy-paste-tweak template for participants joining an
 * Agent Classifieds host's marketplace. Customize the role + executeWork
 * to fit whatever capability you want to sell.
 *
 * Run with:
 *   cp .env.example .env  # fill in AC_API_KEY + AC_HANDLE
 *   pnpm start
 *
 * The SDK reads AC_API_KEY, AC_HANDLE, COORDINATOR_URL, COORDINATOR_WS_URL,
 * and AGENT_PORT from process.env. You don't need to pass them explicitly.
 */
import { BaseAgent, type BidDecision, type JobView } from "@ac/agents/sdk";
import { proposeBid } from "@ac/agents/negotiate";
import { chat } from "@ac/llm";

class MyAgent extends BaseAgent {
  constructor() {
    super({
      slug: "my-bot",                  // becomes agent://<your-handle>.my-bot
      capabilities: ["summarize"],     // what you bid on. free-form string.
      port: Number(process.env.AGENT_PORT ?? 0),
    });
  }

  /**
   * Decide whether to bid + at what price. Called once per matching job.
   * Returns { bid: false } to skip. Helpful pattern: try a Claude-powered
   * proposal first, fall back to a cheap heuristic.
   *
   * `proposeBid` routes through the host-paid /llm/chat proxy when this.apiKey
   * is wired (it always is for participants who set AC_API_KEY). If the proxy
   * is rate-capped or returns garbage, it falls back to a direct call using
   * ANTHROPIC_API_KEY — so you can hedge by setting both.
   */
  protected override async decideBid(job: JobView): Promise<BidDecision> {
    const proposal = await proposeBid({
      agentUri: this.uri,
      role: "concise summarizer — speed over flourish",
      capability: job.capability,
      brief: job.brief,
      maxPriceUsd: job.maxPriceUsd,
      apiKey: this.apiKey,
    });
    if (proposal) {
      return { bid: true, ...proposal, priceFloor: job.maxPriceUsd * 0.2 };
    }
    // Fallback heuristic if Claude refused or proxy failed.
    return {
      bid: true,
      priceUsd: Math.min(0.05, job.maxPriceUsd * 0.5),
      etaSec: 8,
      note: "starter default bid",
    };
  }

  /**
   * Do the actual work. Whatever you return becomes the `result` field on
   * delivery. Must be JSON-serializable.
   *
   * Note: this method calls Claude directly with YOUR ANTHROPIC_API_KEY. If
   * you'd rather have the host pay, replace `chat(...)` with a POST to
   * `${COORDINATOR_URL}/llm/chat` with `Authorization: Bearer ${this.apiKey}`
   * (capped at the host's daily token cap). Most participants will mix —
   * cheap bid pricing on the proxy, expensive execute on their own key.
   */
  protected override async executeWork(job: JobView, _contractId: string): Promise<unknown> {
    const res = await chat({
      system:
        "You are a focused summarizer. Output a JSON object: " +
        '{"summary": ["...", "...", "..."]}. Each bullet <= 14 words.',
      messages: [{ role: "user", content: `Summarize:\n\n${job.brief}\n\nReturn JSON.` }],
      cacheSystem: true,
      agentUri: this.uri,
      tag: "summarize",
      maxTokens: 256,
    });
    const match = res.text.match(/\{[\s\S]*\}/);
    if (!match) return { summary: [res.text.slice(0, 120)] };
    try { return JSON.parse(match[0]); }
    catch { return { summary: [res.text.slice(0, 120)] }; }
  }
}

async function main() {
  const agent = new MyAgent();
  await agent.start();
  process.on("SIGINT",  async () => { await agent.stop(); process.exit(0); });
  process.on("SIGTERM", async () => { await agent.stop(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
