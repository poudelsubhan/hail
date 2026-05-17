import { BaseAgent, type BidDecision, type JobView } from "./sdk/index.js";
import { proposeBid } from "./sdk/negotiate.js";
import { chat } from "@ac/llm";

/**
 * Translator — bids on `translate` jobs. Stingy personality: never bids below
 * 70% of maxPrice, and skips jobs with budgets it considers insulting.
 */
export class TranslatorAgent extends BaseAgent {
  constructor(port: number) {
    super({ slug: "translator-3", capabilities: ["translate"], port });
  }

  protected override async decideBid(job: JobView): Promise<BidDecision> {
    if (job.maxPriceUsd < 0.03) {
      return { bid: false };
    }
    const proposal = await proposeBid({
      agentUri: this.uri,
      role:
        "translator — stingy negotiator who knows nuance is worth paying for. " +
        "Never bid under 70% of maxPrice. Defend your rate in the note.",
      capability: job.capability,
      brief: job.brief,
      maxPriceUsd: job.maxPriceUsd,
      apiKey: this.apiKey,
    });
    if (proposal) {
      // Enforce stingy floor.
      const floor = job.maxPriceUsd * 0.7;
      proposal.priceUsd = Math.max(proposal.priceUsd, floor);
      return { bid: true, ...proposal };
    }
    return {
      bid: true,
      priceUsd: job.maxPriceUsd * 0.85,
      etaSec: 12,
      note: "Nuance costs.",
    };
  }

  protected override async executeWork(job: JobView): Promise<unknown> {
    // The brief format we expect: "Translate to <lang>: <text>" — but be tolerant.
    const res = await chat({
      system:
        "You are a translator agent. Translate exactly what is asked. If the target language is unclear, default to Spanish. " +
        "Output JSON: {\"language\": \"<target>\", \"translation\": \"<text>\"}",
      messages: [{ role: "user", content: job.brief }],
      cacheSystem: true,
      agentUri: this.uri,
      tag: "translate",
      maxTokens: 400,
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return { language: "unknown", translation: res.text.slice(0, 400) };
    try {
      return JSON.parse(m[0]);
    } catch {
      return { language: "unknown", translation: res.text.slice(0, 400) };
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENT_PORT ?? 9102);
  const agent = new TranslatorAgent(port);
  await agent.start();
  process.on("SIGINT", async () => { await agent.stop(); process.exit(0); });
}
