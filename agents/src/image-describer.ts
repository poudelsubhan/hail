import { BaseAgent, type BidDecision, type JobView } from "./sdk/index.js";
import { chat } from "@ac/llm";

/**
 * Image-describer — bids on `image_describe` jobs. For the demo the brief is
 * just a short description ("a busy street market at dusk") and we generate a
 * richer, structured description via Claude. Visual variety in the ticker
 * without needing to wire up actual image inputs.
 */
export class ImageDescriberAgent extends BaseAgent {
  constructor(port: number) {
    super({ slug: "image-describer", capabilities: ["image_describe"], port });
  }

  protected override async decideBid(job: JobView): Promise<BidDecision> {
    return {
      bid: true,
      priceUsd: Math.min(0.05, job.maxPriceUsd * 0.6),
      etaSec: 10,
      note: "Detailed visual breakdown.",
    };
  }

  protected override async executeWork(job: JobView): Promise<unknown> {
    const res = await chat({
      system:
        "You describe images for downstream agents. Given a short scene or image URL, " +
        "produce a rich structured description. Output JSON: " +
        "{\"subjects\": [string], \"setting\": string, \"mood\": string, \"colors\": [string]}",
      messages: [{ role: "user", content: `Describe: ${job.brief}` }],
      cacheSystem: true,
      agentUri: this.uri,
      tag: "image-describe",
      maxTokens: 300,
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return { description: res.text.slice(0, 400) };
    try { return JSON.parse(m[0]); }
    catch { return { description: res.text.slice(0, 400) }; }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENT_PORT ?? 9104);
  const agent = new ImageDescriberAgent(port);
  await agent.start();
  process.on("SIGINT", async () => { await agent.stop(); process.exit(0); });
}
