import { BaseAgent, type BidDecision, type JobView } from "./sdk/index.js";
import { proposeBid } from "./sdk/negotiate.js";
import { chat } from "@ac/llm";

/**
 * Summarizer — bids on `summarize` jobs. Uses Claude for both bid pricing and
 * the actual summarization. Default pricing is cheap so it usually wins.
 */
export class SummarizerAgent extends BaseAgent {
  constructor(port: number) {
    super({
      slug: "summarizer-7",
      capabilities: ["summarize"],
      port,
    });
  }

  protected override async decideBid(job: JobView): Promise<BidDecision> {
    // Try Claude-powered pricing; fall back to a cheap heuristic.
    const proposal = await proposeBid({
      agentUri: this.uri,
      role: "summarizer — fast, terse, knows that quality summaries are short",
      capability: job.capability,
      brief: job.brief,
      maxPriceUsd: job.maxPriceUsd,
      apiKey: this.apiKey,
    });
    // Floor low enough that scenario-3 wars can cross the skeptic threshold.
    const floor = Math.max(0.02, job.maxPriceUsd * 0.15);
    if (proposal) {
      return { bid: true, ...proposal, priceFloor: floor };
    }
    return {
      bid: true,
      priceUsd: Math.min(0.03, job.maxPriceUsd * 0.4),
      etaSec: 6,
      note: "default heuristic bid",
      priceFloor: floor,
    };
  }

  protected override async executeWork(job: JobView, _contractId: string): Promise<unknown> {
    const res = await chat({
      system:
        "You are a summarizer agent. Produce a 3-bullet summary (each <= 14 words). " +
        "Output a JSON object: {\"summary\": [\"...\", \"...\", \"...\"]}",
      messages: [
        {
          role: "user",
          content: `Summarize:\n\n${job.brief}\n\nReturn JSON.`,
        },
      ],
      cacheSystem: true,
      agentUri: this.uri,
      tag: "summarize",
      maxTokens: 256,
    });
    const match = res.text.match(/\{[\s\S]*\}/);
    if (!match) return { summary: [res.text.slice(0, 120)] };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { summary: [res.text.slice(0, 120)] };
    }
  }
}

// Allow `tsx summarizer.ts` to run it standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENT_PORT ?? 9101);
  const agent = new SummarizerAgent(port);
  await agent.start();
  process.on("SIGINT", async () => { await agent.stop(); process.exit(0); });
}
