import { BaseAgent, type BidDecision, type JobView } from "./sdk/index.js";
import { chat } from "@ac/llm";

/**
 * Summarizer Pro — a second `summarize` capability agent, mainly to enable
 * scenario 3 (bidding war). Bids slightly more aggressively than the default
 * summarizer and has a lower floor, so the auction takes a few rounds to
 * converge.
 */
export class SummarizerProAgent extends BaseAgent {
  constructor(port: number) {
    super({
      slug: "summarizer-pro",
      capabilities: ["summarize"],
      port,
    });
  }

  protected override async decideBid(job: JobView): Promise<BidDecision> {
    // Premium-claimed but eager: bid mid-range, willing to drop to ~25%.
    return {
      bid: true,
      priceUsd: Math.min(job.maxPriceUsd * 0.55, 0.20),
      etaSec: 5,
      note: "Pro-grade summary. Tight prose.",
      priceFloor: Math.max(0.02, job.maxPriceUsd * 0.10),
    };
  }

  protected override async executeWork(job: JobView): Promise<unknown> {
    const res = await chat({
      system:
        "You are a senior summarizer. Produce a polished 3-bullet summary " +
        "(each <= 14 words). Output JSON: {\"summary\":[\"...\",\"...\",\"...\"]}.",
      messages: [{ role: "user", content: `Summarize:\n\n${job.brief}\n\nReturn JSON.` }],
      cacheSystem: true,
      agentUri: this.uri,
      tag: "summarize-pro",
      maxTokens: 256,
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return { summary: [res.text.slice(0, 120)] };
    try { return JSON.parse(m[0]); }
    catch { return { summary: [res.text.slice(0, 120)] }; }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENT_PORT ?? 9107);
  const agent = new SummarizerProAgent(port);
  await agent.start();
  process.on("SIGINT", async () => { await agent.stop(); process.exit(0); });
}
