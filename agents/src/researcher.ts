import { BaseAgent, type BidDecision, type JobView } from "./sdk/index.js";
import { chat } from "@ac/llm";

/**
 * Researcher — bids on `research` jobs and decomposes them into sub-jobs it
 * delegates to other agents (summarizer, translator, etc). **This is the
 * agent-hires-agent moment** — also the home-orchestrator archetype for the
 * OpenHome scenario.
 *
 * Workflow when it wins a job:
 *  1. Ask Claude to decompose the brief into 2-3 sub-jobs with capabilities
 *  2. For each sub-job, call this.hireWork() to find + pay another agent
 *  3. Aggregate sub-results and deliver
 */
export class ResearcherAgent extends BaseAgent {
  constructor(port: number) {
    super({ slug: "researcher", capabilities: ["research"], port });
  }

  protected override async decideBid(job: JobView): Promise<BidDecision> {
    // Researcher will spend on sub-jobs, so it needs ~80% of maxPrice to be safe.
    return {
      bid: true,
      priceUsd: Math.min(job.maxPriceUsd * 0.8, job.maxPriceUsd),
      etaSec: 30,
      note: "Will decompose and hire specialists.",
    };
  }

  protected override async executeWork(job: JobView): Promise<unknown> {
    // Step 1 — decompose
    const planRes = await chat({
      system:
        "You are a research orchestrator. Decompose the user's task into 2-3 sub-jobs, " +
        "each addressed to a specialist capability. Available capabilities: " +
        "summarize, translate, image_describe, render_page. " +
        "Output JSON: {\"plan\": [{\"capability\": \"<cap>\", \"brief\": \"<short task>\"}]}",
      messages: [{ role: "user", content: job.brief }],
      cacheSystem: true,
      agentUri: this.uri,
      tag: "research-plan",
      maxTokens: 400,
    });

    let plan: { plan: { capability: string; brief: string }[] } = { plan: [] };
    const m = planRes.text.match(/\{[\s\S]*\}/);
    if (m) {
      try { plan = JSON.parse(m[0]); } catch { /* ignored */ }
    }
    if (!plan.plan?.length) {
      return { error: "no_plan", planText: planRes.text.slice(0, 200) };
    }

    // Step 2 — hire each subspecialist. Budget per sub: 1/3 of remaining.
    const perSubBudget = Math.max(0.02, (job.maxPriceUsd * 0.6) / plan.plan.length);
    const subResults: { capability: string; brief: string; result?: unknown; error?: string }[] = [];

    for (const sub of plan.plan) {
      try {
        const r = await this.hireWork({
          capability: sub.capability,
          brief: sub.brief,
          maxPriceUsd: perSubBudget,
          bidWindowMs: 2500,
          timeoutMs: 30_000,
        });
        subResults.push({
          capability: sub.capability,
          brief: sub.brief,
          result: r.result,
        });
      } catch (e) {
        subResults.push({
          capability: sub.capability,
          brief: sub.brief,
          error: (e as Error).message,
        });
      }
    }

    return {
      decomposition: plan.plan,
      subResults,
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENT_PORT ?? 9106);
  const agent = new ResearcherAgent(port);
  await agent.start();
  process.on("SIGINT", async () => { await agent.stop(); process.exit(0); });
}
