import type { FastifyInstance } from "fastify";
import { BaseAgent, type BidDecision, type JobView } from "./sdk/index.js";
import { chat } from "@ac/llm";

/**
 * Page-renderer — bids on `render_page` jobs. Uses Claude to generate
 * Tailwind HTML and hosts the result at `<agent.url>/pages/<id>`. Returns
 * `{ url }` in the deliver payload so the dashboard can iframe it in.
 *
 * This is the Coframe-flavored agent — its existence is what lets the demo
 * flatter Coframe's generative-web thesis.
 */
export class PageRendererAgent extends BaseAgent {
  private pages = new Map<string, string>(); // pageId -> html

  constructor(port: number) {
    super({ slug: "page-renderer", capabilities: ["render_page"], port });
  }

  protected override registerExtraRoutes(app: FastifyInstance): void {
    app.get<{ Params: { id: string } }>("/pages/:id", async (req, reply) => {
      const html = this.pages.get(req.params.id);
      if (!html) return reply.code(404).send("not found");
      reply.header("content-type", "text/html; charset=utf-8");
      return html;
    });
  }

  protected override async decideBid(job: JobView): Promise<BidDecision> {
    // Page rendering is the headline demo — bid aggressively to win.
    return {
      bid: true,
      priceUsd: Math.min(0.35, job.maxPriceUsd * 0.7),
      // Sonnet HTML render + WS round-trip from public coord can take 20–30s
      // in prod. Sweeper deadline = etaSec * 2, so 45s gives 90s of cushion.
      etaSec: 45,
      note: "Tailwind page from the brief.",
    };
  }

  protected override async executeWork(job: JobView, contractId: string): Promise<unknown> {
    // Step up to Sonnet for HTML quality — this is the headline demo.
    const res = await chat({
      model: "claude-sonnet-4-6",
      system:
        "You are a page renderer. Output a complete standalone HTML document " +
        "using Tailwind via CDN (<script src=\"https://cdn.tailwindcss.com\"></script>). " +
        "Make it dense, beautiful, and on-brief. No comments. No markdown. " +
        "Wrap final output between <!DOCTYPE html> and </html>. Do not include any prose around it.",
      messages: [
        {
          role: "user",
          content: `Render a single landing page for:\n\n${job.brief}\n\nReturn only the HTML.`,
        },
      ],
      cacheSystem: true,
      agentUri: this.uri,
      tag: "render-page",
      maxTokens: 2400,
      temperature: 0.4,
    });

    // Extract the doc — Claude usually returns it raw, but be defensive.
    const docStart = res.text.indexOf("<!DOCTYPE html>");
    const html =
      docStart >= 0
        ? res.text.slice(docStart)
        : `<!DOCTYPE html><html><body><pre>${escapeHtml(res.text)}</pre></body></html>`;

    const pageId = contractId.replace(/^con_/, "p_");
    this.pages.set(pageId, html);
    const url = `${this.url}/pages/${pageId}`;
    return { url, title: job.brief.slice(0, 80) };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENT_PORT ?? 9105);
  const agent = new PageRendererAgent(port);
  await agent.start();
  process.on("SIGINT", async () => { await agent.stop(); process.exit(0); });
}
