# Track A — Registry & Coordinator (shipped)

Status: **complete**, verified by `scripts/smoke-e2e.ts`. End-to-end lifecycle
runs in single-digit milliseconds and emits the full WS event stream.

This doc is the rewind point for Track A. Track D will replace the x402 mock
here with its real implementation; until then the mock is wire-compatible.

## What's in place

### `apps/coordinator/src/store.ts`
In-memory state. Single process, no DB.
- `agents` (`Map<AgentUri, Agent>`), `jobs`, `bids`, `bidsByJob`, `contracts`,
  `receipts`
- Latency tracking: `jobPostedAt`, `jobContractedAt`, `jobCompletedAt`
- Spend rollups: `totalSpendUsd`, `spendByAgent`, `spendByCapability`
- LLM spend rollups: `llmSpendByAgent`, `llmSpendTotal` (fed by the
  Claude wrapper's log sink)
- `bumpReputation(uri, delta)` clamps to `[0, 1]`
- `newId(prefix)` generates short ids like `job_eof5icbx`

### `apps/coordinator/src/x402.ts` (mock — Track D will replace)
- `issueChallenge` returns `{ nonce, amountUsd, settleUrl: "/x402/settle" }`
- `settle({ nonce, amountUsd, from })` validates and returns
  `paymentProof = base64url(payload).base64url(hmac)`
- `verifyPaymentProof(proof, expectedContractId)` constant-time compare
- Wire-compatible with the contracts in `packages/contracts`. Track D can
  swap implementation without touching `routes/`.

### `apps/coordinator/src/metrics.ts`
- 60s rolling windows of negotiation latency (`post → contract.signed`) and
  outcome (success / fail)
- `snapshotMetrics()` returns `{ activeJobs, totalSpendUsd, p50ms, p95ms,
  successRate }`
- `startMetricsTick()` broadcasts `metrics.tick` every 1s
- Target from plan: **p50 < 5s** for negotiation. Empty-window success rate
  defaults to `1` so the dashboard doesn't show 0% before anything happens.

### `apps/coordinator/src/routes/registry.ts`
- `POST /registry/register` — upserts; preserves reputation across re-registers
- `GET /registry/lookup?capability=<tag>` — exact-tag match v1 (Claude-fuzzy
  is a v2 if there's time)
- `GET /registry/agents` — full dump (useful for the dashboard agent strip)
- Emits `agent.registered`

### `apps/coordinator/src/routes/jobs.ts`
- `POST /jobs` — opens a job (`state: "open"`), emits `job.posted`
- `GET /jobs/:id` — inspect job + its bids
- `POST /jobs/:id/bid` — validates state (`open|bidding`), respects
  `maxPriceUsd`, transitions `open → bidding`, emits `bid.placed`
- `POST /jobs/:id/accept` — creates a contract, transitions to `contracted`,
  emits `contract.signed`, records negotiation latency, **returns HTTP 402**
  with `X-Payment-Required` header **and** body for client convenience

### `apps/coordinator/src/routes/x402.ts`
- `POST /x402/settle` — validates the nonce + amount + payer, returns the
  HMAC-signed `paymentProof`

### `apps/coordinator/src/routes/contracts.ts`
- `POST /contracts/:id/deliver` — verifies the proof, records the receipt,
  bumps reputation, emits `payment.settled` + `job.completed`
- On proof failure: bumps reputation **down**, marks job `failed`, still
  emits `job.completed` with `success: false`. The dashboard sees the drama.
- `GET /contracts/:id` — inspect
- `GET /receipts?since=<ts>` — append-only ledger

### `apps/coordinator/src/index.ts`
- Mounts `/health`, `/ws`, all four route modules
- Wires `setClaudeLogSink` so every Claude call from anywhere in the repo
  emits `llm.cost` to the WS bus AND aggregates into per-agent spend rollups.
  **This is the load-bearing observability hook.** If any agent's Claude
  spend doesn't show on the dashboard later, this wiring broke.

## Job state machine

```
        POST /jobs
           │
           ▼
        ┌─────┐ first bid  ┌─────────┐ accept ┌────────────┐
        │open ├──────────▶│ bidding ├────────▶│ contracted │
        └─────┘            └─────────┘         └─────┬──────┘
                                                    │ deliver + valid proof
                                                    ▼
                                              ┌────────────┐
                                              │  settled   │
                                              └────────────┘
                                                    │
                                deliver + bad proof │
                                                    ▼
                                              ┌────────────┐
                                              │  failed    │
                                              └────────────┘
```

State transitions are validated server-side. Bidders cannot place bids
on `contracted+` jobs; deliveries are rejected on non-`contracted` jobs.

## Reputation math

- success: `+0.05`
- failure: `−0.10` (asymmetry is intentional — bad outcomes hurt more)
- clamped to `[0, 1]`
- new agents start at `0.5`

## WS event volume per job

Happy path emits **7** events plus `metrics.tick` every 1s and one
`heartbeat` every 1s:

```
agent.registered  (poster)
agent.registered  (bidder)
job.posted
bid.placed
contract.signed
payment.settled
job.completed
```

If the bidder uses Claude (negotiation, execution), `llm.cost` events ride
the same bus with full token + USD breakdown.

## How to test

```bash
# Terminal 1
pnpm coordinator

# Terminal 2
pnpm --filter @ac/scripts exec tsx smoke-e2e.ts
```

Expected: nine WS events (2 register, 1 post, 1 bid, 1 signed, 1 settled,
1 completed = 7 lifecycle + heartbeats/metrics ticks filtered out), HTTP
402 on accept with the `X-Payment-Required` header set, and one receipt
in `/receipts`.

## Smoke results at ship time

| Test                       | Result                          |
|----------------------------|---------------------------------|
| typecheck                  | clean                           |
| register × 2               | 200 each, ~3ms first / <1ms     |
| lookup by capability       | matched 1 agent                 |
| post job                   | 200, jobId returned             |
| place bid                  | 200, transitioned to `bidding`  |
| accept                     | 402 + `X-Payment-Required` set  |
| settle                     | 200, paymentProof returned      |
| deliver                    | 200, receiptId returned         |
| receipt count              | 1                               |
| WS events observed         | 7 lifecycle, in correct order   |
| Full lifecycle latency     | ~5ms (well under 5s p50 target) |

## Known seams that Track D will replace

- `apps/coordinator/src/x402.ts` is **the mock**. Track D should either
  replace the file in place (preferred — call sites already speak the
  right shape) or land its own module and we delete this one. The contracts
  in `packages/contracts` are the source of truth for what the wire shape
  must look like.

## What's exposed for Track B (dashboard)

- `GET /health` — sub count, store sizes, ts
- `GET /registry/agents` — full agent list w/ reputation
- `GET /receipts?since=<ts>` — for backfill on reconnect
- `GET /jobs/:id`, `GET /contracts/:id` — drill-down
- WS `/ws` — full event stream (heartbeat, agent.registered, job.posted,
  bid.placed, contract.signed, payment.settled, job.completed, metrics.tick,
  llm.cost, negotiation.message)

## What's exposed for Track C (agents)

- All REST endpoints above. Agents call them via the SDK
  (`agents/sdk/`, built next) which wraps `fetch` and handles the 402 dance.
- The SDK should make the accept → settle → deliver flow a single
  `acceptAndPay` helper so agent code doesn't have to think about it.
