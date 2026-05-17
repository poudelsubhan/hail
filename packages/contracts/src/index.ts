import { z } from "zod";

/* ============================================================
 * Agent Classifieds — Contracts (the constitution)
 * Any change here is announced. Mocks drift = integration breaks.
 * ============================================================ */

// v2: `agent://<handle>.<slug>`. The `(.local)?` suffix is kept for back-compat
// with v1 system agents that still register as `agent://<slug>.local`.
export const AgentUri = z
  .string()
  .regex(
    /^agent:\/\/[a-z0-9][a-z0-9-]{0,30}\.[a-z0-9][a-z0-9-]{0,30}(\.local)?$/i,
    "agent://<handle>.<slug>",
  );
export type AgentUri = z.infer<typeof AgentUri>;

/** Pull the leading handle out of an agent URI. */
export function handleFromUri(uri: string): string | null {
  const m = /^agent:\/\/([a-z0-9][a-z0-9-]{0,30})\./i.exec(uri);
  return m ? m[1]!.toLowerCase() : null;
}

export const Capability = z.string().min(1);
export type Capability = z.infer<typeof Capability>;

export const Agent = z.object({
  uri: AgentUri,
  url: z.string().url(),
  capabilities: z.array(Capability),
  pubkey: z.string(),
  reputation: z.number().min(0).max(1).default(0.5),
});
export type Agent = z.infer<typeof Agent>;

export const JobState = z.enum([
  "open",
  "bidding",
  "contracted",
  "delivering",
  "settled",
  "failed",
]);
export type JobState = z.infer<typeof JobState>;

export const Job = z.object({
  jobId: z.string(),
  posterUri: AgentUri,
  capability: Capability,
  brief: z.string(),
  maxPriceUsd: z.number().nonnegative(),
  state: JobState,
  createdAt: z.number(),
});
export type Job = z.infer<typeof Job>;

export const Bid = z.object({
  bidId: z.string(),
  jobId: z.string(),
  bidderUri: AgentUri,
  priceUsd: z.number().nonnegative(),
  etaSec: z.number().nonnegative(),
  note: z.string().optional(),
  createdAt: z.number(),
});
export type Bid = z.infer<typeof Bid>;

export const Contract = z.object({
  contractId: z.string(),
  jobId: z.string(),
  posterUri: AgentUri,
  bidderUri: AgentUri,
  priceUsd: z.number().nonnegative(),
  ts: z.number(),
});
export type Contract = z.infer<typeof Contract>;

export const Receipt = z.object({
  receiptId: z.string(),
  contractId: z.string(),
  from: AgentUri,
  to: AgentUri,
  amountUsd: z.number().nonnegative(),
  ts: z.number(),
});
export type Receipt = z.infer<typeof Receipt>;

/* ---------------- REST request/response ---------------- */

export const RegisterReq = z.object({
  uri: AgentUri,
  url: z.string().url(),
  capabilities: z.array(Capability),
  pubkey: z.string(),
});
export type RegisterReq = z.infer<typeof RegisterReq>;

export const LookupRes = z.object({ agents: z.array(Agent) });
export type LookupRes = z.infer<typeof LookupRes>;

export const PostJobReq = z.object({
  posterUri: AgentUri,
  capability: Capability,
  brief: z.string(),
  maxPriceUsd: z.number().positive(),
});
export type PostJobReq = z.infer<typeof PostJobReq>;

export const PostJobRes = z.object({ jobId: z.string() });
export type PostJobRes = z.infer<typeof PostJobRes>;

export const PlaceBidReq = z.object({
  bidderUri: AgentUri,
  priceUsd: z.number().nonnegative(),
  etaSec: z.number().nonnegative(),
  note: z.string().optional(),
});
export type PlaceBidReq = z.infer<typeof PlaceBidReq>;

export const PlaceBidRes = z.object({ bidId: z.string() });
export type PlaceBidRes = z.infer<typeof PlaceBidRes>;

export const AcceptBidReq = z.object({ bidId: z.string() });
export type AcceptBidReq = z.infer<typeof AcceptBidReq>;

// `accept` responds HTTP 402 + X-Payment-Required header (see X402Challenge)
// On a non-402 path (e.g., dev poke) it can also return JSON.
export const AcceptBidRes = z.object({
  contractId: z.string(),
  challenge: z.object({
    amountUsd: z.number().nonnegative(),
    settleUrl: z.string(),
    nonce: z.string(),
  }),
});
export type AcceptBidRes = z.infer<typeof AcceptBidRes>;

export const DeliverReq = z.object({
  result: z.unknown(), // capability-specific payload
  paymentProof: z.string(),
});
export type DeliverReq = z.infer<typeof DeliverReq>;

export const DeliverRes = z.object({ receiptId: z.string() });
export type DeliverRes = z.infer<typeof DeliverRes>;

/* ---------------- WebSocket events (dashboard subscribes) ---------------- */

export const WsHeartbeat = z.object({
  type: z.literal("heartbeat"),
  ts: z.number(),
});

export const WsAgentRegistered = z.object({
  type: z.literal("agent.registered"),
  uri: AgentUri,
  capabilities: z.array(Capability),
  ts: z.number(),
});

export const WsJobPosted = z.object({
  type: z.literal("job.posted"),
  jobId: z.string(),
  posterUri: AgentUri,
  capability: Capability,
  brief: z.string(),
  maxPriceUsd: z.number(),
  ts: z.number(),
});

export const WsBidPlaced = z.object({
  type: z.literal("bid.placed"),
  jobId: z.string(),
  bidId: z.string(),
  bidderUri: AgentUri,
  priceUsd: z.number(),
  etaSec: z.number(),
  note: z.string().optional(),
  ts: z.number(),
});

export const WsContractSigned = z.object({
  type: z.literal("contract.signed"),
  contractId: z.string(),
  jobId: z.string(),
  parties: z.tuple([AgentUri, AgentUri]),
  priceUsd: z.number(),
  ts: z.number(),
});

export const WsPaymentSettled = z.object({
  type: z.literal("payment.settled"),
  contractId: z.string(),
  receiptId: z.string(),
  priceUsd: z.number(),
  ts: z.number(),
});

export const WsJobCompleted = z.object({
  type: z.literal("job.completed"),
  jobId: z.string(),
  success: z.boolean(),
  latencyMs: z.number(),
  result: z.unknown().optional(), // may carry { url } for page-renderer
  ts: z.number(),
});

export const WsMetricsTick = z.object({
  type: z.literal("metrics.tick"),
  activeJobs: z.number(),
  totalSpendUsd: z.number(),
  p50ms: z.number(),
  p95ms: z.number(),
  successRate: z.number(),
  ts: z.number(),
});

export const WsNegotiation = z.object({
  type: z.literal("negotiation.message"),
  jobId: z.string(),
  from: AgentUri,
  to: AgentUri,
  round: z.number(),
  proposal: z.object({
    priceUsd: z.number(),
    etaSec: z.number(),
    scopeCaveats: z.array(z.string()).optional(),
  }),
  ts: z.number(),
});

/** v2: coordinator pushes this over the bidder's authenticated WS once
 *  payment is settled. Replaces v1's `POST /work` to the bidder. */
export const WsWorkAssigned = z.object({
  type: z.literal("work.assigned"),
  contractId: z.string(),
  jobId: z.string(),
  bidderUri: AgentUri,
  capability: Capability,
  brief: z.string(),
  paymentProof: z.string(),
  deadlineMs: z.number(),
  ts: z.number(),
});

/** v2: deadline sweeper marks a contract as timed out. The dashboard ticker
 *  renders this in red. A `job.completed { success: false }` is also emitted
 *  for downstream reducers. */
export const WsContractTimedOut = z.object({
  type: z.literal("contract.timed_out"),
  contractId: z.string(),
  jobId: z.string(),
  bidderUri: AgentUri,
  ageMs: z.number(),
  ts: z.number(),
});

/** v3: emitted on every wallet debit/credit. Drives the WalletStrip panel
 *  without polling and feeds a per-wallet timeline. */
export const WsWalletChanged = z.object({
  type: z.literal("wallet.changed"),
  walletId: z.string(),
  agentUri: AgentUri.optional(),
  balanceUsd: z.number(),
  deltaUsd: z.number(),
  reason: z.string(),
  ts: z.number(),
});

export const WsLlmCost = z.object({
  type: z.literal("llm.cost"),
  agentUri: AgentUri.optional(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costUsd: z.number(),
  latencyMs: z.number(),
  promptHash: z.string(),
  ts: z.number(),
});

export const WsEvent = z.discriminatedUnion("type", [
  WsHeartbeat,
  WsAgentRegistered,
  WsJobPosted,
  WsBidPlaced,
  WsContractSigned,
  WsPaymentSettled,
  WsJobCompleted,
  WsMetricsTick,
  WsNegotiation,
  WsLlmCost,
  WsWorkAssigned,
  WsContractTimedOut,
  WsWalletChanged,
]);
export type WsEvent = z.infer<typeof WsEvent>;

/* ---------------- Negotiation envelope (agent ↔ agent) ---------------- */

export const NegotiationMessage = z.object({
  intent: z.literal("negotiate"),
  round: z.number().int().min(1),
  from: AgentUri,
  to: AgentUri,
  jobId: z.string(),
  proposal: z.object({
    priceUsd: z.number().nonnegative(),
    etaSec: z.number().nonnegative(),
    scopeCaveats: z.array(z.string()).optional(),
  }),
  decision: z.enum(["counter", "accept", "reject"]).optional(),
});
export type NegotiationMessage = z.infer<typeof NegotiationMessage>;

/* ---------------- x402-shaped payment ---------------- */

export const X402ChallengeHeader = z.object({
  amountUsd: z.number().positive(),
  settleUrl: z.string(),
  nonce: z.string(),
});
export type X402ChallengeHeader = z.infer<typeof X402ChallengeHeader>;

export const X402SettleReq = z.object({
  nonce: z.string(),
  amountUsd: z.number().positive(),
  from: AgentUri,
});
export type X402SettleReq = z.infer<typeof X402SettleReq>;

export const X402SettleRes = z.object({
  paymentProof: z.string(), // HMAC-signed token
});
export type X402SettleRes = z.infer<typeof X402SettleRes>;

/** Shape encoded into the HMAC proof (the body, before signing).
 *  v3: payload carries wallet IDs so per-wallet ledger / chain-explorer
 *  views have an authoritative record of which wallet paid which. */
export const X402ProofPayload = z.object({
  contractId: z.string(),
  amountUsd: z.number().positive(),
  nonce: z.string(),
  from: AgentUri,
  ts: z.number(),
  fromWalletId: z.string().optional(),
  toWalletId: z.string().optional(),
});
export type X402ProofPayload = z.infer<typeof X402ProofPayload>;

export const X402_HEADER = "x-payment-required" as const;
