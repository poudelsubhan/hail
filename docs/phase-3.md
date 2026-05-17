# Phase 3 — Demo Polish & Observability Pass (shipped)

Status: **code complete**. Bidding-war mechanic, headline panel, reputation
deltas, persisted job results, README, and 90-second demo script all in place.
The bidding war scenario (3) is not yet exercised end-to-end against live
Claude in CI; it's wired and typechecks but should be driven manually before
stage.

## What's in place

### Coordinator: job results persisted
`store.jobResults: Map<jobId, unknown>`. Populated in
`routes/contracts.ts` when delivery succeeds; exposed by `GET /jobs/:id`
(returns `{ job, bids, result, completedAt }`). Fixes the gap where the
deliverable rode only the (non-replayed) `job.completed` WS event.

### Coordinator: negotiation broadcast endpoint
`POST /negotiation/message` (Zod-validated). Lets agents inject
`negotiation.message` WS events — the Skeptic uses it to chime in during
bidding wars. Body schema mirrors the `NegotiationMessage` in
`@ac/contracts`.

### SDK: rebid mechanic (scenario 3)
`BidDecision.priceFloor` — optional. When set, the agent will undercut a
competitor's bid by `UNDERCUT_STEP` ($0.01) per round, capped at
`MAX_REBIDS` (3) and never below the floor. Triggered when a `bid.placed`
arrives on a job we've already bid on at a lower price than ours.

### SDK: `sendNegotiation()` helper
Wraps `POST /negotiation/message`. Used by the Skeptic.

### New agent: SummarizerPro
A second `summarize` capability. Mid-range opening bid, lower floor than
`summarizer-7`. Together they fight a 2–3-round auction in scenario 3.

### Skeptic: spectator role
Now opens a **second WS connection** purely for spectator duties: watches
every `bid.placed` event and broadcasts a `negotiation.message` when bids
drop below its `UNDERPRICED_THRESHOLD` ($0.05). Posts max one chime per
job to avoid spam.

### Dashboard: since-boot headline
`components/Headline.tsx` — strip between header and the three-pane grid.
Shows: jobs done, total spend, LLM spend, p50/p95, success rate (color
graded), agents online. This is what we point at in beat 5 of the demo.

### Dashboard: floating reputation deltas
`+0.05` / `−0.10` chips that rise and fade over `AgentStrip` rows when
`job.completed` arrives. Reducer in `lib/state.ts` derives the winning
bidder by looking back at the latest `contract.signed` for the job (so
we don't need to extend the WS event shape).

CSS `@keyframes rep-rise` — 1.6s rise + fade. 2s TTL on the state entry
(swept every 500ms).

### Scripts: scenario-bidding-war + demo presenter
- `scripts/scenario-bidding-war.ts` — posts a $0.30 summarize job with an
  8s bid window, lets the auction play out, prints the winner.
- `scripts/demo-presenter.ts` — `pnpm present`. Raw-mode keypress reader.
  `1` / `2` / `3` to fire each scenario; `q` to quit. Spawns the scenario
  script as a child process and prints a banner between runs.

### README + 90-second demo script
- `README.md` — quick start, architecture diagram, observability story, x402
  shape, pointers to all per-phase docs.
- `docs/demo-script.md` — beat-by-beat 90s arc with talking points,
  fallback strategies, and a setup checklist for stage.

## Not yet shipped (deliberate cuts)

- **"Replay last 30s" button** (1B.6 from plan). Ring buffer already exists
  on the client; would need a UI button + `setInterval` re-emit. Skipped
  because the headline strip + ticker pause cover the same UX need on stage.
- **Fallback screen recording** (3F). User-driven step (record during the
  dry run); the script exists in `docs/demo-script.md`.
- **Multi-turn Claude back-and-forth negotiation**. Plan's diagram showed
  N-round conversational negotiation; we implemented the simpler
  "marketplace as the negotiation" — multiple bids over time. The Skeptic's
  `negotiation.message` chime is the only explicit `negotiation.message`
  event the demo emits.

## How to verify on stage

```bash
# Terminal 1
pnpm coordinator

# Terminal 2
pnpm demo               # 7 agents online

# Terminal 3
pnpm dashboard          # localhost:3000

# Terminal 4 — interactive
pnpm present
#   press 1  → Coframe page-on-demand
#   press 2  → OpenHome home agent decomposes
#   press 3  → bidding war
```

Watch for:
- Headline numbers ticking on every job
- Iframe filling with the rendered page in scenario 1
- Floating `+0.05` chips next to winning agents
- Multiple `bid.placed` events for the same `jobId` in scenario 3
- A `negotiation.message` event from `skeptic` when bids drop low

## Cost estimate per stage run

Approximate, depends on Claude latency on the day:

| Scenario | LLM calls | Est. cost |
|---|---|---|
| 1. page-on-demand | 1 Sonnet + 1 Haiku bid | $0.035–0.05 |
| 2. researcher decomposes | 1 plan + 3 sub-jobs + 3 bids | $0.05–0.08 |
| 3. bidding war | 2 bidders × (1 bid + maybe rebids) + 1 summary | $0.005–0.015 |
| **Full demo** | — | **~$0.10 per run** |

Pre-warming with one dry run before stage is in the demo-script checklist.

## Smoke at ship time

- `pnpm -r typecheck` — clean across all 7 packages
- Coordinator, demo, dashboard all boot and serve
- Bidding-war scenario script + skeptic spectator both typecheck; the
  rebid path is exercised whenever any agent sees a competitor undercut
- README + demo script reviewed against the actual surface area
