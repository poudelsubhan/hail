import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import type {
  AgentUri,
  Bid,
  Job,
  WsEvent,
  X402ChallengeHeader,
} from "@ac/contracts";
import { setClaudeLogSink, type ClaudeCallLog } from "@ac/llm";

/**
 * Agent SDK v2 — authed, NAT-friendly. Each agent owns an apiKey + handle;
 * URI becomes `agent://<handle>.<slug>`. Work is pushed over the authed WS
 * (`work.assigned`), not delivered to an inbound HTTP port. Outbound HTTP
 * (deliver, bid, etc.) still goes coord-ward and works through NAT.
 *
 * Concrete agents implement `decideBid` + `executeWork`. Everything else —
 * register, subscribe, ack work, deliver — is handled here.
 */

export interface AgentConfig {
  /** Becomes agent://<handle>.<slug>. Must be url-safe slug. */
  slug: string;
  capabilities: string[];
  /** Optional HTTP listen port for /health + custom routes (e.g. page-renderer's
   *  /pages/:id). 0 = OS-assigned. Set to -1 to skip HTTP boot entirely. */
  port: number;
  /** Bearer apiKey from /signup. Defaults to AC_API_KEY then AC_HOST_API_KEY. */
  apiKey?: string;
  /** User handle that owns the agent URI. Defaults to AC_HANDLE then AC_HOST_HANDLE. */
  handle?: string;
  coordUrl?: string;
  coordWsUrl?: string;
}

/**
 * Check whether the coordinator already has at least one agent serving the
 * given capability. Scenarios call this to decide whether to boot their own
 * specialist or assume `pnpm demo` already did.
 */
export async function capabilityServed(
  capability: string,
  coordUrl = process.env.COORDINATOR_URL ?? "http://localhost:8787",
): Promise<boolean> {
  try {
    const res = await fetch(
      `${coordUrl}/registry/lookup?capability=${encodeURIComponent(capability)}`,
    );
    if (!res.ok) return false;
    const { agents } = (await res.json()) as { agents: unknown[] };
    return Array.isArray(agents) && agents.length > 0;
  } catch {
    return false;
  }
}

export interface JobView {
  jobId: string;
  posterUri: AgentUri;
  capability: string;
  brief: string;
  maxPriceUsd: number;
}

export interface BidDecision {
  bid: boolean;
  priceUsd?: number;
  etaSec?: number;
  note?: string;
  /** When set, the agent will rebid lower if a competitor undercuts above this floor. */
  priceFloor?: number;
}

export abstract class BaseAgent {
  readonly uri: AgentUri;
  readonly handle: string;
  readonly apiKey: string;
  /** Finalized in bootHttp after the server binds — important for port: 0. */
  url = "http://0.0.0.0:0";
  protected readonly coordUrl: string;
  protected readonly coordWsUrl: string;
  protected ws!: WebSocket;
  protected server: FastifyInstance | null = null;
  protected wonContracts = new Map<string, string>();
  private myBids = new Map<string, { priceUsd: number; floor: number; rebids: number; eta: number; capability: string }>();
  private static MAX_REBIDS = 3;
  private static UNDERCUT_STEP = 0.01;
  private postedJobs = new Map<
    string,
    { bids: Bid[]; resolveAt: number; resolve: (bids: Bid[]) => void }
  >();
  private completionWaiters = new Map<
    string,
    (evt: { success: boolean; result?: unknown; latencyMs: number }) => void
  >();

  constructor(public readonly config: AgentConfig) {
    const apiKey = config.apiKey ?? process.env.AC_API_KEY ?? process.env.AC_HOST_API_KEY;
    if (!apiKey) {
      throw new Error(
        "agent apiKey missing — set AC_API_KEY (per-user) or AC_HOST_API_KEY (host-owned) or pass apiKey in AgentConfig",
      );
    }
    const handle = (config.handle ?? process.env.AC_HANDLE ?? process.env.AC_HOST_HANDLE ?? "host").toLowerCase();
    this.apiKey = apiKey;
    this.handle = handle;
    this.uri = `agent://${handle}.${config.slug}` as AgentUri;
    this.coordUrl = config.coordUrl ?? process.env.COORDINATOR_URL ?? "http://localhost:8787";
    const baseWs = config.coordWsUrl ?? process.env.COORDINATOR_WS_URL ?? "ws://localhost:8787/ws";
    // Append apiKey query param. The coordinator uses it to tag the socket
    // for direct-push (work.assigned) routing.
    const sep = baseWs.includes("?") ? "&" : "?";
    this.coordWsUrl = `${baseWs}${sep}apiKey=${encodeURIComponent(apiKey)}`;
  }

  protected async decideBid(_job: JobView): Promise<BidDecision> {
    return { bid: false };
  }

  protected abstract executeWork(job: JobView, contractId: string): Promise<unknown>;

  protected registerExtraRoutes(_app: FastifyInstance): void | Promise<void> {
    return;
  }

  async start(): Promise<void> {
    this.wireLlmTelemetry();
    if (this.config.port !== -1) {
      await this.bootHttp();
    }
    await this.register();
    this.connectWs();
    process.stderr.write(`[${this.uri}] online @ ${this.url}\n`);
  }

  /**
   * Forward every direct-Claude call from this process to the coordinator so
   * the dashboard sees ALL LLM spend, not just calls made inside the
   * coordinator. Calls routed through `/llm/chat` (the proxy) are already
   * logged server-side; this only matters for participants who use their own
   * ANTHROPIC_API_KEY.
   */
  private wireLlmTelemetry() {
    setClaudeLogSink((log: ClaudeCallLog) => {
      process.stderr.write(
        `[claude:${log.agentUri ?? "?"}] model=${log.model} in=${log.inputTokens} out=${log.outputTokens} cost=$${log.costUsd.toFixed(6)} ${log.latencyMs}ms\n`,
      );
      fetch(this.coordUrl + "/telemetry/llm-cost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(log),
      }).catch(() => {/* fire-and-forget */});
    });
  }

  async stop(): Promise<void> {
    try { this.ws?.close(); } catch {}
    try { await this.server?.close(); } catch {}
  }

  private async bootHttp() {
    const app = Fastify({ logger: false });
    app.get("/health", async () => ({ ok: true, uri: this.uri }));
    await this.registerExtraRoutes(app);
    await app.listen({ port: this.config.port, host: "0.0.0.0" });
    this.server = app;
    const addr = app.server.address();
    const boundPort =
      typeof addr === "object" && addr ? addr.port : this.config.port;
    this.url = `http://localhost:${boundPort}`;
  }

  private async register() {
    await this.coordPost("/registry/register", {
      uri: this.uri,
      url: this.url,
      capabilities: this.config.capabilities,
      pubkey: `pk_${this.handle}_${this.config.slug}`,
    });
  }

  private connectWs() {
    const ws = new WebSocket(this.coordWsUrl);
    this.ws = ws;
    ws.on("message", (data) => {
      let evt: WsEvent;
      try { evt = JSON.parse(data.toString()); } catch { return; }
      this.handleEvent(evt);
    });
    ws.on("close", () => {
      setTimeout(() => this.connectWs(), 500);
    });
    ws.on("error", () => {/* swallow; close will retry */});
  }

  private handleEvent(evt: WsEvent) {
    if (evt.type === "job.posted") {
      if (!this.config.capabilities.includes(evt.capability)) return;
      if (evt.posterUri === this.uri) return;
      void this.respondToJob({
        jobId: evt.jobId,
        posterUri: evt.posterUri,
        capability: evt.capability,
        brief: evt.brief,
        maxPriceUsd: evt.maxPriceUsd,
      });
    } else if (evt.type === "bid.placed") {
      const window = this.postedJobs.get(evt.jobId);
      if (window) {
        window.bids.push({
          bidId: evt.bidId,
          jobId: evt.jobId,
          bidderUri: evt.bidderUri,
          priceUsd: evt.priceUsd,
          etaSec: evt.etaSec,
          note: evt.note,
          createdAt: evt.ts,
        });
      }
      const mine = this.myBids.get(evt.jobId);
      if (mine && evt.bidderUri !== this.uri && evt.priceUsd < mine.priceUsd) {
        void this.maybeRebid(evt.jobId, evt.priceUsd);
      }
    } else if (evt.type === "contract.signed") {
      const [, bidder] = evt.parties;
      if (bidder === this.uri) {
        this.wonContracts.set(evt.contractId, evt.jobId);
      }
    } else if (evt.type === "work.assigned") {
      // v2: pushTo() targets all sockets owned by the bidder's user — in the
      // single-host demo every agent shares the host user, so we filter on
      // bidderUri to make sure only the winning agent runs the work.
      if (evt.bidderUri !== this.uri) return;
      void this.handleWorkAssigned(evt);
    } else if (evt.type === "job.completed") {
      const waiter = this.completionWaiters.get(evt.jobId);
      if (waiter) {
        waiter({ success: evt.success, result: evt.result, latencyMs: evt.latencyMs });
        this.completionWaiters.delete(evt.jobId);
      }
    }
  }

  private async handleWorkAssigned(evt: {
    contractId: string;
    jobId: string;
    capability: string;
    brief: string;
    paymentProof: string;
  }) {
    // The contract may not have come through `contract.signed` yet if we
    // raced — fetchJob is the source of truth.
    const jobView = await this.fetchJob(evt.jobId).catch((e) => {
      process.stderr.write(`[${this.uri}] fetchJob failed: ${(e as Error).message}\n`);
      return null;
    });
    if (!jobView) return;
    // contract.signed has already populated wonContracts if we won; backfill
    // in case the broadcast order raced us.
    if (!this.wonContracts.has(evt.contractId)) {
      this.wonContracts.set(evt.contractId, evt.jobId);
    }
    try {
      const result = await this.executeWork(jobView, evt.contractId);
      const r = await this.coordPost<{ receiptId: string }>(
        `/contracts/${evt.contractId}/deliver`,
        { result, paymentProof: evt.paymentProof },
      );
      process.stderr.write(
        `[${this.uri}] delivered contract=${evt.contractId} receipt=${r.receiptId}\n`,
      );
    } catch (e) {
      process.stderr.write(
        `[${this.uri}] deliver failed contract=${evt.contractId}: ${(e as Error).message}\n`,
      );
    }
  }

  private async respondToJob(job: JobView) {
    let decision: BidDecision;
    try {
      decision = await this.decideBid(job);
    } catch (e) {
      process.stderr.write(`[${this.uri}] decideBid threw: ${(e as Error).message}\n`);
      return;
    }
    if (!decision.bid) return;
    const priceUsd = Math.min(decision.priceUsd ?? job.maxPriceUsd, job.maxPriceUsd);
    const etaSec = decision.etaSec ?? 10;
    try {
      await this.coordPost(`/jobs/${job.jobId}/bid`, {
        bidderUri: this.uri,
        priceUsd,
        etaSec,
        note: decision.note,
      });
      this.myBids.set(job.jobId, {
        priceUsd,
        floor: decision.priceFloor ?? priceUsd,
        rebids: 0,
        eta: etaSec,
        capability: job.capability,
      });
      if ((decision.priceFloor ?? priceUsd) < priceUsd) {
        try {
          const { bids } = await this.coordGet<{
            bids: { bidderUri: string; priceUsd: number }[];
          }>(`/jobs/${job.jobId}`);
          let lowest: { bidderUri: string; priceUsd: number } | null = null;
          for (const b of bids) {
            if (b.bidderUri === this.uri) continue;
            if (!lowest || b.priceUsd < lowest.priceUsd) lowest = b;
          }
          if (lowest && lowest.priceUsd < priceUsd) {
            await this.maybeRebid(job.jobId, lowest.priceUsd);
          }
        } catch {/* race with state transitions — fine */}
      }
    } catch (e) {
      process.stderr.write(`[${this.uri}] bid skipped: ${(e as Error).message}\n`);
    }
  }

  private async maybeRebid(jobId: string, competitorPrice: number) {
    const mine = this.myBids.get(jobId);
    if (!mine) return;
    if (mine.rebids >= BaseAgent.MAX_REBIDS) return;
    const targetPrice = competitorPrice - BaseAgent.UNDERCUT_STEP;
    if (targetPrice < mine.floor) return;
    if (targetPrice >= mine.priceUsd) return;
    try {
      await this.coordPost(`/jobs/${jobId}/bid`, {
        bidderUri: this.uri,
        priceUsd: targetPrice,
        etaSec: mine.eta,
        note: `Undercut round ${mine.rebids + 1}.`,
      });
      mine.priceUsd = targetPrice;
      mine.rebids += 1;
      process.stderr.write(
        `[${this.uri}] rebid ${mine.rebids} on ${jobId} @ $${targetPrice.toFixed(3)}\n`,
      );
    } catch (e) {
      process.stderr.write(`[${this.uri}] rebid skipped: ${(e as Error).message}\n`);
    }
  }

  protected async sendNegotiation(opts: {
    jobId: string;
    to: AgentUri;
    round?: number;
    proposal: { priceUsd: number; etaSec: number; scopeCaveats?: string[] };
  }): Promise<void> {
    try {
      await this.coordPost("/negotiation/message", {
        jobId: opts.jobId,
        from: this.uri,
        to: opts.to,
        round: opts.round ?? 1,
        proposal: opts.proposal,
      });
    } catch (e) {
      process.stderr.write(`[${this.uri}] negotiation send failed: ${(e as Error).message}\n`);
    }
  }

  /**
   * Post a job, wait for bids, pick one, accept + settle. v2: the coordinator
   * pushes `work.assigned` to the bidder over their WS — we don't HTTP-poke
   * the bidder anymore. We just wait for `job.completed` and return.
   */
  async hireWork(opts: {
    capability: string;
    brief: string;
    maxPriceUsd: number;
    bidWindowMs?: number;
    pickBid?: (bids: Bid[]) => Bid | undefined;
    timeoutMs?: number;
  }): Promise<{ success: boolean; result?: unknown; latencyMs: number; spendUsd: number }> {
    const { jobId } = await this.coordPost<{ jobId: string }>("/jobs", {
      posterUri: this.uri,
      capability: opts.capability,
      brief: opts.brief,
      maxPriceUsd: opts.maxPriceUsd,
    });
    process.stderr.write(`[${this.uri}] posted job=${jobId} cap=${opts.capability}\n`);

    const bidWindowMs = opts.bidWindowMs ?? 3000;
    const bids = await this.collectBids(jobId, bidWindowMs);
    if (bids.length === 0) {
      throw new Error(`no_bids_for_${jobId}`);
    }

    const pick =
      opts.pickBid?.(bids) ??
      bids.reduce((best, b) => (b.priceUsd < best.priceUsd ? b : best), bids[0]!);
    process.stderr.write(
      `[${this.uri}] accepting bid=${pick.bidId} from=${pick.bidderUri} price=$${pick.priceUsd}\n`,
    );

    const acc = await this.coordPostRaw(`/jobs/${jobId}/accept`, { bidId: pick.bidId });
    if (acc.status !== 402) {
      throw new Error(`expected_402_got_${acc.status}: ${await acc.text()}`);
    }
    const accBody = (await acc.json()) as {
      contractId: string;
      challenge: { nonce: string; amountUsd: number; settleUrl: string };
    };

    const completion = new Promise<{ success: boolean; result?: unknown; latencyMs: number }>(
      (resolve, reject) => {
        this.completionWaiters.set(jobId, resolve);
        setTimeout(() => {
          if (this.completionWaiters.has(jobId)) {
            this.completionWaiters.delete(jobId);
            reject(new Error(`completion_timeout_${jobId}`));
          }
        }, opts.timeoutMs ?? 60_000);
      },
    );

    // Settle. The coordinator pushes work.assigned to the bidder; we just wait.
    await this.coordPost<{ paymentProof: string }>("/x402/settle", {
      nonce: accBody.challenge.nonce,
      amountUsd: accBody.challenge.amountUsd,
      from: this.uri,
    });

    const done = await completion;
    return {
      success: done.success,
      result: done.result,
      latencyMs: done.latencyMs,
      spendUsd: accBody.challenge.amountUsd,
    };
  }

  private collectBids(jobId: string, windowMs: number): Promise<Bid[]> {
    return new Promise((resolve) => {
      const entry = {
        bids: [] as Bid[],
        resolveAt: Date.now() + windowMs,
        resolve,
      };
      this.postedJobs.set(jobId, entry);
      setTimeout(() => {
        this.postedJobs.delete(jobId);
        resolve(entry.bids);
      }, windowMs);
    });
  }

  protected async coordPost<T>(path: string, body: unknown): Promise<T> {
    const res = await this.coordPostRaw(path, body);
    if (!res.ok) {
      throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  protected async coordPostRaw(path: string, body: unknown): Promise<Response> {
    return fetch(this.coordUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  protected async coordGet<T>(path: string): Promise<T> {
    const res = await fetch(this.coordUrl + path, {
      headers: { "authorization": `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  protected async fetchJob(jobId: string): Promise<JobView> {
    const { job } = await this.coordGet<{ job: Job }>(`/jobs/${jobId}`);
    return {
      jobId: job.jobId,
      posterUri: job.posterUri,
      capability: job.capability,
      brief: job.brief,
      maxPriceUsd: job.maxPriceUsd,
    };
  }

  protected async fetchAgent(uri: AgentUri): Promise<{ uri: string; url: string }> {
    const { agents } = await this.coordGet<{ agents: { uri: AgentUri; url: string }[] }>(
      "/registry/agents",
    );
    const a = agents.find((x) => x.uri === uri);
    if (!a) throw new Error(`agent_not_in_registry: ${uri}`);
    return a;
  }
}

export type { X402ChallengeHeader };
