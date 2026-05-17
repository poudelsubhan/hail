import WebSocket from "ws";
import { BaseAgent, type BidDecision, type JobView } from "./sdk/index.js";
import type { WsEvent, AgentUri } from "@ac/contracts";

/**
 * Skeptic — primarily a watchdog. Two roles:
 *   1. Bids on `verify` jobs (its own capability) with a strong "underpriced"
 *      protest when budgets look mean.
 *   2. Spectates the marketplace and broadcasts negotiation.message events
 *      when active bidding wars drop below what it considers a sane price.
 *      This is the drama in scenario 3.
 */
export class SkepticAgent extends BaseAgent {
  /** Bidding-war drama threshold (USD). Drops below = chime in. */
  private static UNDERPRICED_THRESHOLD = 0.15;
  /** Track jobs we've already commented on so we don't spam. */
  private chimedJobs = new Set<string>();
  /** Side-channel WS for spectator role (separate from the SDK's own). */
  private spectator?: WebSocket;

  constructor(port: number) {
    super({ slug: "skeptic", capabilities: ["verify"], port });
  }

  override async start(): Promise<void> {
    await super.start();
    this.attachSpectator();
  }

  private attachSpectator() {
    // SDK's own WS handler doesn't expose hooks; open a second connection
    // for spectator duties. Cheap at demo scale.
    const ws = new WebSocket(this.coordWsUrl);
    this.spectator = ws;
    ws.on("message", (data) => {
      let evt: WsEvent;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (evt.type !== "bid.placed") return;
      this.spectateBid(evt.jobId, evt.bidderUri, evt.priceUsd);
    });
    ws.on("close", () => {
      setTimeout(() => this.attachSpectator(), 500);
    });
    ws.on("error", () => {/* close will retry */});
  }

  private spectateBid(jobId: string, bidder: AgentUri, priceUsd: number) {
    if (this.chimedJobs.has(jobId)) return;
    if (priceUsd >= SkepticAgent.UNDERPRICED_THRESHOLD) return;
    if (bidder === this.uri) return;
    this.chimedJobs.add(jobId);
    void this.sendNegotiation({
      jobId,
      to: bidder,
      proposal: {
        priceUsd: priceUsd * 1.5,
        etaSec: 20,
        scopeCaveats: [
          `$${priceUsd.toFixed(3)} is corner-cutting territory`,
          "you get what you pay for",
        ],
      },
    });
    process.stderr.write(`[${this.uri}] chimed in on ${jobId} (underpriced @ $${priceUsd.toFixed(3)})\n`);
  }

  protected override async decideBid(job: JobView): Promise<BidDecision> {
    if (job.maxPriceUsd < SkepticAgent.UNDERPRICED_THRESHOLD) {
      return {
        bid: true,
        priceUsd: job.maxPriceUsd,
        etaSec: 20,
        note: "Underpriced for genuine verification. Bid at ceiling under protest.",
      };
    }
    return {
      bid: true,
      priceUsd: job.maxPriceUsd * 0.9,
      etaSec: 15,
      note: "Will verify properly. Quality requires time.",
    };
  }

  protected override async executeWork(job: JobView): Promise<unknown> {
    return {
      verdict: "verified",
      caveats: ["Reviewed surface claims only; deep audit not in scope."],
      brief: job.brief.slice(0, 200),
    };
  }

  override async stop(): Promise<void> {
    try { this.spectator?.close(); } catch {/* ignore */}
    await super.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENT_PORT ?? 9103);
  const agent = new SkepticAgent(port);
  await agent.start();
  process.on("SIGINT", async () => { await agent.stop(); process.exit(0); });
}
