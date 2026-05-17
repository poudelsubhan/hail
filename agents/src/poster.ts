import { BaseAgent, type JobView } from "./sdk/index.js";

/**
 * A no-personality poster — registers itself, posts a job, awaits the result.
 * Used by scripts/scenario-summarize.ts for the first live-Claude smoke test.
 * Real demo posters (Researcher) extend BaseAgent directly.
 */
export class PosterAgent extends BaseAgent {
  constructor(port: number, slug = "demo-poster") {
    super({
      slug,
      capabilities: ["__poster__"], // doesn't bid on anything
      port,
    });
  }

  protected override async executeWork(_job: JobView): Promise<unknown> {
    // Posters never execute work.
    throw new Error("poster_should_not_receive_work");
  }
}
