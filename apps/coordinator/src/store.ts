import type {
  Agent,
  AgentUri,
  Bid,
  Contract,
  Job,
  Receipt,
} from "@ac/contracts";

/**
 * Single-process in-memory state. Dies with the process — on purpose.
 * No DB, no Redis. If you find yourself wanting persistence here, you're
 * over-scoping.
 */
class Store {
  agents = new Map<AgentUri, Agent>();
  jobs = new Map<string, Job>();
  bids = new Map<string, Bid>();
  // bids per jobId, in insertion order
  bidsByJob = new Map<string, string[]>();
  contracts = new Map<string, Contract>();
  receipts = new Map<string, Receipt>();

  /** v2: side data about live contracts that doesn't belong in the contract
   *  envelope (which is replayed to dashboard). Holds escrow + deadline info
   *  needed by the sweeper, and the owner user-ids for wallet operations. */
  contractMeta = new Map<
    string,
    {
      etaSec: number;
      posterUserId: string;
      bidderUserId: string;
      posterWalletId: string;
      bidderWalletId: string;
      acceptedAt: number;
      escrowUsd: number;
      escrowReleased: boolean;
      paymentProof?: string;
    }
  >();

  // For latency metrics: jobId -> ts when posted
  jobPostedAt = new Map<string, number>();
  // jobId -> ts when contract.signed (post → contract latency)
  jobContractedAt = new Map<string, number>();
  // jobId -> ts when job.completed (post → settle latency)
  jobCompletedAt = new Map<string, number>();
  // jobId -> success bool (for success rate)
  jobOutcome = new Map<string, boolean>();
  // jobId -> deliverable result (summary text, page URL, etc.). Persisted so
  // `GET /jobs/:id` is the source of truth on dashboard reconnect — without
  // this the result only rides the (non-replayed) job.completed WS event.
  jobResults = new Map<string, unknown>();

  totalSpendUsd = 0;
  spendByAgent = new Map<AgentUri, number>();
  spendByCapability = new Map<string, number>();

  llmSpendByAgent = new Map<AgentUri, number>();
  llmSpendTotal = 0;

  /** Ring of recently-posted jobs for capability discovery. Cap by count
   *  (rather than time) to keep the data structure simple; the dashboard
   *  filters by ts when rendering. */
  recentJobs: { capability: string; ts: number; brief: string; jobId: string }[] = [];
  private static RECENT_JOBS_CAP = 200;

  recordPostedJob(jobId: string, capability: string, brief: string, ts: number) {
    this.recentJobs.push({ jobId, capability, brief, ts });
    if (this.recentJobs.length > Store.RECENT_JOBS_CAP) {
      this.recentJobs.splice(0, this.recentJobs.length - Store.RECENT_JOBS_CAP);
    }
  }

  bumpReputation(uri: AgentUri, delta: number) {
    const a = this.agents.get(uri);
    if (!a) return;
    const next = Math.max(0, Math.min(1, a.reputation + delta));
    this.agents.set(uri, { ...a, reputation: next });
  }

  recordSpend(opts: {
    from: AgentUri;
    to: AgentUri;
    capability: string;
    amountUsd: number;
  }) {
    this.totalSpendUsd += opts.amountUsd;
    this.spendByAgent.set(
      opts.to,
      (this.spendByAgent.get(opts.to) ?? 0) + opts.amountUsd,
    );
    this.spendByCapability.set(
      opts.capability,
      (this.spendByCapability.get(opts.capability) ?? 0) + opts.amountUsd,
    );
  }

  recordLlmSpend(amountUsd: number, agentUri?: AgentUri) {
    this.llmSpendTotal += amountUsd;
    if (agentUri) {
      this.llmSpendByAgent.set(
        agentUri,
        (this.llmSpendByAgent.get(agentUri) ?? 0) + amountUsd,
      );
    }
  }
}

export const store = new Store();

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
