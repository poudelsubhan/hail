# Track C — Agent SDK + 6 agents + demo runner (shipped)

Status: **complete**, summarize scenario verified end-to-end with real Claude
calls. All 6 agents register and come online under `pnpm demo`.

## What's in place

### `agents/src/sdk/index.ts` — `BaseAgent`
Every concrete agent extends this. It:
- Boots a Fastify HTTP server on `port` (so the agent has an addressable URL)
- Hits `POST /registry/register` on the coordinator
- Opens a WebSocket to `/ws` and routes events to handlers
- Bidder pattern: when `job.posted` arrives with a capability we serve,
  calls `decideBid` (subclass override) and `POST /jobs/:id/bid`
- Bidder pattern: when `contract.signed` arrives with us as bidder, remembers
  the contractId and waits for the poster to push proof
- Bidder pattern: `POST /work` accepts `{ contractId, paymentProof }`, calls
  `executeWork`, then `POST /contracts/:id/deliver`
- **Poster pattern**: `hireWork({ capability, brief, maxPriceUsd })` runs the
  full post → collect-bids → accept (402) → settle → push-proof-to-bidder →
  wait-for-completion dance. **The agent-hires-agent helper.**
- **Telemetry**: wires `setClaudeLogSink` so every Claude call from any agent
  in the process POSTs to `/telemetry/llm-cost` on the coordinator — this is
  what makes the dashboard's per-agent LLM spend column accurate.

### `agents/src/sdk/negotiate.ts` — `proposeBid()`
Single-turn Claude call (Haiku 4.5, 128 max tokens, prompt-cached system
block) that returns `{ priceUsd, etaSec, note }` for a given role + brief.
Cheap by design — bids should not dominate the cost budget.

Returns `null` when Claude refuses or output can't be parsed → agent falls
back to a hand-coded heuristic.

### Agents shipped

| Agent | Capability | Personality / pricing |
|---|---|---|
| `SummarizerAgent` | `summarize` | Cheap, terse. Bids ~40% of maxPrice. Returns 3-bullet JSON. |
| `TranslatorAgent` | `translate` | **Stingy** — floor at 70% of maxPrice; refuses jobs under $0.03. |
| `SkepticAgent` | `verify` | Counter-bids at ceiling when underpriced. Currently no Claude in `executeWork` (drama is in the ticker). |
| `ImageDescriberAgent` | `image_describe` | Structured visual breakdown via Claude. |
| `PageRendererAgent` | `render_page` | **Sonnet 4.6** for quality. Generates Tailwind HTML, hosts at `/pages/:id`, returns `{ url }`. The Coframe agent. |
| `ResearcherAgent` | `research` | Decomposes via Claude, then calls `hireWork()` to delegate 2-3 sub-jobs to other agents. The OpenHome agent. |

### `agents/src/poster.ts`
A no-personality poster used by scenarios and the demo runner. Registers as
`agent://<slug>.local` with a `__poster__` capability so it doesn't get bid
events; only initiates work.

### `scripts/demo.ts` — `pnpm demo`
Boots coordinator (if not already running) + all 6 agents in **one process**.
Single-process keeps demo ergonomics simple; running each agent file
standalone with `tsx` also works for closer-to-prod testing.

Detects an already-running coordinator and skips re-boot, so you can run
`pnpm coordinator` in one terminal and `pnpm demo` in another.

### Scenario scripts (per-scenario drivers)

| Script | What it does |
|---|---|
| `scripts/scenario-summarize.ts` | Posts a summarize job, watches Claude propose a bid + summarize, prints lifecycle + spend rollups. **Verified.** |
| `scripts/scenario-page-render.ts` | The Coframe slice — posts a `render_page` job, expects URL back, fetches the rendered HTML to confirm it serves. |
| `scripts/scenario-research.ts` | The OpenHome slice — posts a `research` job; Researcher decomposes and delegates. Multi-agent receipts on the WS. |

Root npm scripts: `pnpm scenario:summarize`, `pnpm scenario:page`,
`pnpm scenario:research`.

## Wire flow inside a job (bidder POV)

```
coordinator                     agent                           poster
   │  job.posted (ws) ────────▶ │ decideBid()                      │
   │ ◀── POST /jobs/:id/bid ────│                                  │
   │  bid.placed (ws)           │                                  │
   │ ◀── POST /jobs/:id/accept ─────────────────────────────────── │
   │  HTTP 402 + X-Payment-Required ─────────────────────────────▶ │
   │  contract.signed (ws) ───▶ │ stores wonContracts[cid]=jobId   │
   │ ◀── POST /x402/settle ──────────────────────────────────────  │
   │  paymentProof ─────────────────────────────────────────────▶  │
   │                            │ ◀── POST /work {cid, proof} ──── │
   │                            │  executeWork(job)                │
   │                            │  → Claude call(s)                │
   │ ◀── POST /contracts/:id/deliver { result, paymentProof }      │
   │  job.completed (ws) ─────▶ poster's completion waiter         │
```

## Observability — every Claude call is metered

Critical and easy to break: the `setClaudeLogSink` hook in the agent SDK
forwards `{model, in/out/cache tokens, costUsd, latencyMs, promptHash,
agentUri}` to `POST /telemetry/llm-cost` on the coordinator. The
coordinator then:
1. Aggregates into `store.llmSpendByAgent` and `store.llmSpendTotal`
2. Publishes a `llm.cost` WS event tagged with the agentUri

If a future Claude call doesn't appear on the dashboard, check this hook
is being installed — `wireLlmTelemetry()` runs in `BaseAgent.start()`.

## Verified end-to-end

```
pnpm coordinator          # terminal 1
pnpm scenario:summarize   # terminal 2
```

Result:
- Two Claude calls (Haiku 4.5): bid proposal (155 in, 78 out, $0.000545) +
  summarize (155 in, 78 out, $0.000500) — total LLM spend **$0.001045**
- Marketplace spend $0.08
- Reputation 0.50 → 0.55 (success delta)
- Full lifecycle latency **~5s** (well under the p50 < 5s target)
- All 9 expected WS events fired in order: `agent.registered` ×2, `job.posted`,
  `bid.placed`, `contract.signed`, `llm.cost` ×2, `payment.settled`,
  `job.completed`

## How to test the other scenarios

```bash
pnpm coordinator              # terminal 1
pnpm demo                     # terminal 2 — all 6 agents online
pnpm scenario:page            # terminal 3 — Coframe page-on-demand
pnpm scenario:research        # terminal 3 — OpenHome multi-agent decompose
```

Page render: posts a brief, expects an HTML page hosted on the renderer.
Research: posts a multi-step task, the Researcher decomposes and hires
summarizer + translator + image-describer.

## Known follow-ups (Phase 3)

- Multi-round negotiation (escalating rebids) is currently single-turn —
  scenario 3 ("bidding war") will need an extension to `proposeBid` that
  re-runs after seeing a competing bid.
- Skeptic's `executeWork` returns a static verdict; could route through
  Claude for richer commentary if time.
- No Python parity yet (plan calls it "optional"). Skip unless we have
  time after Phase 3 polish.

## Cost guardrails

- Default model: **Haiku 4.5** ($1/$5 per Mtok). Page-renderer escalates to
  **Sonnet 4.6** ($3/$15) because HTML quality matters for the Coframe demo.
- All bid proposals are capped at 128 max tokens.
- Summarize/translate/describe are capped at 256–400 max tokens.
- Page render is capped at 2400 max tokens (~$0.04/page worst case).
- Prompt caching enabled on every agent's system prompt. The second job an
  agent runs should hit cache (~10% of input cost).
