# Agent Classifieds — Implementation Plan

## Context & Key Findings

- **Greenfield build** for the AGI House "Internet of Agents" hackathon hosted by Coframe.
- Stack: Next.js (App Router) + TypeScript + WebSockets for coordinator and dashboard. Python optional for example agents — they only need to speak the wire protocol. Single-process in-memory state, no DB.
- Claude (Anthropic SDK) drives agent-to-agent negotiation — what makes the demo feel alive vs. canned.
- Settlement is **x402-shaped but mocked**: HTTP 402 + nonce + HMAC-signed proof. Coframe judges will recognize the shape; we don't depend on a real chain.
- **The dashboard IS the observability layer** — cost per task, p50/p95 latency, success rate, reputation deltas, x402 spend. Meter ships with the feature, not after.

## Interface Contracts (LOCK BEFORE PARALLEL WORK)

These are the seams between tracks. Once Phase 0 ratifies them, all four tracks build in parallel against mocks of each other. Lives in `packages/contracts/index.ts` as TypeScript types + Zod schemas.

### Agent identity
- URI format: `agent://<slug>.local` (e.g., `agent://summarizer-7.local`)
- Registry resolves to: `{ url, publicKey, capabilities[], reputation }`

### REST endpoints (coordinator)
- `POST /registry/register` — `{ uri, url, capabilities: string[], pubkey }`
- `GET  /registry/lookup?capability=<tag>` — matching agents
- `POST /jobs` — `{ posterUri, capability, brief, maxPriceUsd }` → `{ jobId }`
- `POST /jobs/:id/bid` — `{ bidderUri, priceUsd, etaSec, note }` → `{ bidId }`
- `POST /jobs/:id/accept` — `{ bidId }` → returns 402 challenge from Track D
- `POST /contracts/:id/deliver` — `{ result, paymentProof }` → `{ receiptId }`

### WebSocket events (dashboard subscribes)
- `agent.registered { uri, capabilities }`
- `job.posted { jobId, posterUri, capability, brief, maxPriceUsd, ts }`
- `bid.placed { jobId, bidderUri, priceUsd, etaSec, note, ts }`
- `contract.signed { contractId, jobId, parties, priceUsd, ts }`
- `payment.settled { contractId, receiptId, priceUsd, ts }`
- `job.completed { jobId, success, latencyMs, ts }`
- `metrics.tick { activeJobs, totalSpendUsd, p50ms, p95ms, successRate }`

### Negotiation message (agent ↔ agent, via Claude)
```json
{ "intent":"negotiate", "round":1, "from":"agent://...", "to":"agent://...",
  "proposal": { "priceUsd":0.05, "etaSec":8, "scopeCaveats":["max 500 tokens"] } }
```

### x402-shaped payment
- `accept` responds with `HTTP 402` + header `X-Payment-Required: { amountUsd, settleUrl:"/x402/settle", nonce }`
- Agent POSTs `/x402/settle` with `{ nonce, amountUsd, from }` → returns HMAC-signed `paymentProof`
- `paymentProof` carried into `deliver` to close the loop

## Track Map (Layer 2 — teammate ownership)

After Phase 0, each track is one teammate's territory; they work to completion against the contracts without blocking on each other.

- **Track A — Registry & Coordinator** (REST + WS server, in-memory state, job state machine)
- **Track B — Dashboard & Live Ticker** (Next.js UI, WS subscriber, metric panels)
- **Track C — Example Agents & Demo Scenarios** (5+ agents, Claude negotiation loop, scripted run)
- **Track D — Payments Mock & Receipts** (x402-shaped 402 + settle + receipt log + spend rollups)

Solo-builder fallback: do A → D → C → B with mocked seams; collapse Phase 2 into rolling integration.

---

## Phase 0 — Foundations & Contract Lock

All tracks block on this phase. Output: a runnable empty skeleton everyone agrees on. Tasks parallel.

### 0A. Repo scaffold
Pnpm workspaces. `apps/coordinator`, `apps/dashboard` (Next.js), `agents/` (Node + Python examples), `packages/contracts`, `packages/llm`.

### 0B. Ratify interface contracts
Walk the contracts above with teammates. Anyone can object now and only now. Land them in `packages/contracts/index.ts` as exported TS types + Zod schemas.

### 0C. WebSocket fan-out skeleton
WS server in `apps/coordinator` that accepts subscribers and broadcasts. Emits a synthetic `heartbeat` event every 1s so Track B can build against it.

### 0D. Anthropic SDK + env wiring
`.env` with `ANTHROPIC_API_KEY`. Shared helper `packages/llm/claude.ts` wraps `messages.create` with prompt caching enabled, logs `{model, inputTokens, outputTokens, latencyMs, costUsd, promptHash}`. All Claude calls go through this.

---

## Phase 1 — Parallel Tracks Build to Mocks

Depends on Phase 0. Each track builds against mocks of the others. Tasks within a track are parallel unless noted.

### Track A — Registry & Coordinator

- **1A.1** In-memory stores (`agents`, `jobs`, `bids`, `contracts`, `receipts`) + event emitter.
- **1A.2** `POST /registry/register` + `GET /registry/lookup?capability=…`. Exact-tag match v1; Claude-fuzzy v2 if time.
- **1A.3** `POST /jobs` + job state machine: `open → bidding → contracted → delivering → settled | failed`. Emits `job.posted`.
- **1A.4** `POST /jobs/:id/bid` → emits `bid.placed`. Validates job state.
- **1A.5** `POST /jobs/:id/accept` → creates contract, returns Track D's 402 challenge (mocked until 2A), emits `contract.signed`.
- **1A.6** `POST /contracts/:id/deliver` → verifies Track D's proof (mocked until 2A), emits `payment.settled` + `job.completed`.
- **1A.7** `metrics.tick` emitter: every 1s broadcast rolling p50/p95 latency, active jobs, total spend, success rate.

### Track B — Dashboard & Live Ticker

- **1B.1** Layout: three panes — left agent list w/ reputation, center scrolling ticker, right metric cards.
- **1B.2** WS subscriber w/ reconnect backoff; ring buffer of last N events.
- **1B.3** Ticker rows per event type (styled chips, timestamp, key fields). Auto-scroll w/ pause.
- **1B.4** Metric panels: total spend, p50/p95, active jobs, success rate, top agents by reputation.
- **1B.5** Agent strip: capability tags, reputation score, color flash on event.
- **1B.6** Demo polish: big-text projector toggle, "replay last 30s" button, dark mode default.
- **1B.7** Inline result preview pane. When a `job.completed` event carries a `result.url` pointing to an HTML page, render it in a small iframe next to the ticker row. Needed for the Coframe "page-on-demand" scenario to land visually.

### Track C — Example Agents & Demo Scenarios

- **1C.1** Agent SDK micro-library (Node + Python parity): `register`, `lookupAgents`, `postJob`, `placeBid`, `acceptBid`, `deliver`.
- **1C.2** Claude negotiation loop helper: takes `(myCapabilities, jobBrief, role)`, runs up to N rounds, returns final proposal. Uses 0D wrapper.
- **1C.3** Agent: **Summarizer** (`summarize`). Bids on summarize jobs; actually summarizes on deliver.
- **1C.4** Agent: **Translator** (`translate`). Stingy personality — negotiates harder.
- **1C.5** Agent: **Researcher** (`research`). Decomposes its job into sub-jobs to summarizer/translator. **This is the agent-hires-agent moment** — also doubles as the "home-orchestrator" archetype for the OpenHome demo slice (Phase 3).
- **1C.6** Agent: **Image-describer** (`image_describe`). Visual variety.
- **1C.7** Agent: **Skeptic** (`verify`). Rejects underpriced bids — adds drama to the ticker.
- **1C.8** Agent: **Page-renderer** (`render_page`). Bids on `render_page` jobs; uses Claude to generate Tailwind HTML and hosts the result at `<agent.url>/pages/<id>`. Returns `{ url }` in the deliver payload. **This is the Coframe-flavored agent** — its existence is what lets the demo flatter Coframe's generative-web thesis.
- **1C.9** Demo runner: `pnpm demo` boots coordinator + dashboard + all agents and stages the Phase 3 scripted scenarios.

### Track D — Payments Mock & Receipts

- **1D.1** 402 challenge issuer: returns `HTTP 402` + `X-Payment-Required` header w/ amount/nonce/settleUrl. Stores nonce→contractId.
- **1D.2** `POST /x402/settle` validates nonce, marks paid, returns HMAC-signed proof — no DB needed for verification.
- **1D.3** `verifyPaymentProof(proof, expectedContractId)` exported from `packages/contracts`.
- **1D.4** Receipt log (in-memory): `{contractId, from, to, amountUsd, ts}`. Exposed via `GET /receipts?since=…`.
- **1D.5** Spend rollups: `totalSpend`, `spendPerAgent`, `spendPerCapability`. Feeds dashboard cards.

---

## Phase 2 — Integration & End-to-End

Depends on Phase 1. Mocks come out; real components wire together.

- **2A.** Wire Track A ↔ Track D — coordinator returns real 402; deliver verifies real proof.
- **2B.** Point Track C agents at real coordinator. Run one full e2e: post → bid → accept → settle → deliver → receipt.
- **2C.** Track B against real event stream — verify ticker reflects truth; fix schema drift.
- **2D.** First full `pnpm demo` dry run. File issues per track.
- **2E.** Bug bash — each owner fixes their integration bugs; re-run demo until it's clean 3× in a row.

---

## Phase 3 — Demo Polish & Observability Pass

Depends on Phase 2.

- **3A.** Three keypress-triggered scripted demo scenarios — each ~20–40s on stage:
  - **Scenario 1 — Coframe slice: "page-on-demand."** An agent posts `need: render landing page for product X, budget $0.50`. The page-renderer agent (1C.8) bids, negotiates briefly via Claude, gets the contract, generates Tailwind HTML, returns the URL, gets paid in x402. Dashboard inline-previews the rendered page (1B.7). **Coframe's product is a participant in the marketplace.** This is what wins gold.
  - **Scenario 2 — OpenHome slice: "home agent delegates outward."** The Researcher agent (1C.5), framed as a home assistant, gets a real-world-shaped task ("find a recipe matching ingredients X / summarize / translate to Spanish") and decomposes it across three strangers on the protocol — Researcher → Summarizer → Translator. Receipts and reputation deltas flow on screen. **OpenHome's open-ecosystem dream in one demo.**
  - **Scenario 3 — bidding war.** Two agents fight for the same well-priced job, escalating bids round-by-round via Claude. Skeptic agent (1C.7) rejects one as underpriced. Drama in the ticker. Crowd-pleaser.
- **3B.** Dashboard "since-boot" headline panel: total jobs, total spend, p50/p95, success rate, agents online — what we point at in the demo.
- **3C.** Per-agent Claude token spend + dollar cost dashboard, sourced from the LLM helper logs.
- **3D.** Floating `+0.04` reputation deltas next to agent names after `job.completed`.
- **3E.** README + 90-second demo script. Open with the thesis ("agents don't have HTTP yet — strangers can't find each other, agree on terms, or exchange value"), then run the three scenarios in order. Land Scenario 1 with "Coframe's generative web *runs on this*" and Scenario 2 with "this is what an open agent home looks like — your assistant hires strangers, you see every receipt."
- **3F.** Final dry run + record a fallback screen video in case stage Wi-Fi misbehaves.

---

## Observability & Measurement

Dashboard ships as the meter, not a follow-up.

- **Success metrics**:
  - **Job completion rate** (`settled / posted`) — target ≥ 95% in clean demo.
  - **Negotiation latency p50/p95** (`post → contract.signed`) — under 5s p50 to feel alive.
  - **Cost per task USD** (Claude spend ÷ jobs completed) — surfaces whether agent overhead eats marketplace economics.

- **Instrumentation**:
  - Every Claude call logged via `packages/llm/claude.ts`: model, in/out tokens, latency, cost USD, prompt hash.
  - Every coordinator transition (post/bid/accept/settle/deliver) → structured log with `jobId`, `contractId`, agent URIs, latency-since-previous.
  - `metrics.tick` every 1s drives dashboard panels.
  - Full receipt log w/ per-transaction USD.

- **Alerting**: Demo-grade. If the `successRate` panel drops below 80% mid-scenario, abort and run a different scenario.

## Dependency Graph

```
        ┌────────────── Phase 0 — Foundations ──────────────┐
        │  0A scaffold • 0B contracts • 0C ws • 0D LLM      │
        └────────────────────────┬──────────────────────────┘
                                 │  hard gate
        ┌──────────────┬─────────┴─────────┬──────────────┐
        ▼              ▼                   ▼              ▼
     Track A        Track B             Track C        Track D
   (1A.1-1A.7)    (1B.1-1B.6)         (1C.1-1C.8)    (1D.1-1D.5)
        └──────────────┴─────────┬─────────┴──────────────┘
                                 │  hard gate
                ┌────────────────▼────────────────┐
                │   Phase 2 — Integration         │
                │   2A 2B 2C parallel → 2D → 2E   │
                └────────────────┬────────────────┘
                                 │  hard gate
                ┌────────────────▼────────────────┐
                │   Phase 3 — Demo Polish         │
                │   3A 3B 3C 3D parallel → 3E 3F  │
                └─────────────────────────────────┘
```

## Notes for Claude

- **The contracts file is the constitution.** Any schema change must be announced; otherwise mocks drift from real and integration fails.
- **Single-process in-memory is on purpose.** No DB, no Redis, no persistence. State dies with the process.
- **Prompt caching on every Claude call.** Hackathon demos burn tokens fast — use the shared wrapper.
- **`agent://` URIs are namespacing, not DNS.** The registry IS the resolver.
- **x402 is shape, not substance.** 402 + nonce + signed proof is enough to demo the shape.
- **Solo-builder mode**: A → D → C → B, stub each upstream with a minimal mock, integrate rolling. Skip Phase 2 as a discrete phase.
- **Tail latency matters even at demo scale.** p95 > 30s feels broken; < 5s feels alive. Drop Claude temperature, cap `max_tokens` hard, pre-warm.
- **Reputation math**: `+0.05` on success, `−0.1` on failure, clamp 0..1. Don't build Elo.
- **Sponsor-tied scenarios are load-bearing.** Scenario 1 must flatter Coframe (gold prize presenter — generative web) and Scenario 2 must flatter OpenHome (silver — open agent ecosystem). If either looks broken in dry runs, prioritize fixing them over polish on Scenario 3.
- **Page-renderer's `url` lives on the agent, not the coordinator.** Each agent already has a `url` in the registry. The page-renderer hosts its own `/pages/<id>` route; the coordinator stays generic.

---

## Architecture Diagram

### Components

```
                          ┌──────────────────────────┐
                          │  Claude (Anthropic API)  │
                          │  via packages/llm/claude │
                          │  prompt-cached, metered  │
                          └──────────────▲───────────┘
                                         │ negotiation +
                                         │ task execution
                                         │
   ┌────────┐  ┌────────┐  ┌────────┐  ┌─┴──────┐  ┌────────┐  ┌────────┐
   │ Resea- │  │ Summa- │  │ Trans- │  │ Page-  │  │ Image- │  │ Skep-  │
   │ rcher  │  │ rizer  │  │ lator  │  │ render │  │ desc.  │  │ tic    │
   │        │  │        │  │        │  │ (CF)   │  │        │  │        │
   └────┬───┘  └────┬───┘  └────┬───┘  └────┬───┘  └────┬───┘  └────┬───┘
        │           │           │           │           │           │
        │   REST: register · lookup · post · bid · accept · deliver │
        │   x402: settle                                            │
        └───────────┴───────────┬───────────┴───────────┴───────────┘
                                ▼
                  ┌──────────────────────────────┐
                  │        Coordinator           │
                  │      apps/coordinator        │
                  │ ──────────────────────────── │
                  │  • Registry (in-mem)         │
                  │  • Job state machine         │
                  │  • x402 challenge / verify   │
                  │  • Receipt log (append-only) │
                  │  • Metrics aggregator (1Hz)  │
                  │  • WebSocket fan-out         │
                  └──────────────┬───────────────┘
                                 │  WS event stream
                                 │  (typed, Zod-validated)
                                 ▼
                  ┌──────────────────────────────┐
                  │          Dashboard           │
                  │       apps/dashboard         │
                  │ ──────────────────────────── │
                  │  • Live ticker (event log)   │
                  │  • Metric panels             │
                  │  • Reputation strip          │
                  │  • Inline page preview (CF)  │
                  │  • Spend / cost rollups      │
                  └──────────────────────────────┘

   (CF) = participates in Coframe demo scenario
```

### One Full Transaction (sequence)

```
  Poster             Coordinator             Bidder           Dashboard
    │                     │                    │                  │
    │ ── register ───────▶│                    │                  │
    │                     │─── agent.registered ─────────────────▶│
    │                     │                    │                  │
    │                     │◀────── register ───│                  │
    │                     │─── agent.registered ─────────────────▶│
    │                     │                    │                  │
    │ ── POST /jobs ─────▶│                    │                  │
    │                     │─── job.posted ───────────────────────▶│
    │                     │                    │                  │
    │                     │◀── GET /registry/lookup?capability=…  │
    │                     │── candidates ──────▶                  │
    │                     │                    │                  │
    │ ◀══════ Claude-driven negotiation, N rounds ═══════▶        │
    │   structured proposals (price, ETA, scope caveats)          │
    │                     │                    │                  │
    │                     │◀── POST /jobs/:id/bid ─────           │
    │                     │─── bid.placed ───────────────────────▶│
    │                     │                    │                  │
    │ ── POST /jobs/:id/accept ──▶│            │                  │
    │ ◀─── HTTP 402 + X-Payment-Required ──    │                  │
    │                     │─── contract.signed ──────────────────▶│
    │                     │                    │                  │
    │ ── POST /x402/settle ──────▶│            │                  │
    │ ◀── HMAC-signed paymentProof ────────    │                  │
    │                     │─── payment.settled ──────────────────▶│
    │                     │                    │                  │
    │ ──── proof handoff over agent channel ──▶│                  │
    │                     │                    │                  │
    │                     │◀── POST /contracts/:id/deliver        │
    │                     │     { result, paymentProof }          │
    │                     │─── job.completed ────────────────────▶│
    │                     │                    │                  │
    │                     │─── metrics.tick (1Hz) ───────────────▶│
    │                     │     p50/p95, spend, success, repΔ     │
```

### Data shapes that cross the wire

```
agent      = { uri, url, capabilities[], pubkey, reputation }
job        = { jobId, posterUri, capability, brief, maxPriceUsd,
               state: open|bidding|contracted|delivering|settled|failed }
bid        = { bidId, jobId, bidderUri, priceUsd, etaSec, note }
contract   = { contractId, jobId, posterUri, bidderUri, priceUsd, ts }
challenge  = HTTP 402 + X-Payment-Required: { amountUsd, settleUrl, nonce }
proof      = HMAC( { contractId, amountUsd, ts }, SERVER_SECRET )
receipt    = { contractId, from, to, amountUsd, ts, proofId }
```
