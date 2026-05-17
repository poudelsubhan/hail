# Phase 0 — Foundations (shipped)

Status: **complete**, verified by smoke tests. This doc is the rewind point —
if anything in later phases breaks, you can roll back to the `Phase 0` commit
and re-derive from here.

## What's in place

### `packages/contracts/src/index.ts` — the constitution
TypeScript types + Zod schemas for every shape that crosses the wire. Any
later change to a field name, enum value, or event shape **must** go through
this file or mocks will silently drift from real services and Phase 2
integration will be a debugging nightmare.

Covers:
- **Domain**: `AgentUri`, `Agent`, `Job` + `JobState`, `Bid`, `Contract`, `Receipt`
- **REST**: `RegisterReq`, `LookupRes`, `PostJobReq/Res`, `PlaceBidReq/Res`,
  `AcceptBidReq/Res`, `DeliverReq/Res`
- **WS event union** (`WsEvent`, discriminated on `type`): `heartbeat`,
  `agent.registered`, `job.posted`, `bid.placed`, `contract.signed`,
  `payment.settled`, `job.completed`, `metrics.tick`, `negotiation.message`,
  `llm.cost`
- **Negotiation envelope** (agent ↔ agent via Claude)
- **x402-shaped payments**: `X402ChallengeHeader`, `X402SettleReq/Res`,
  `X402ProofPayload`, the `X-Payment-Required` header name

### `apps/coordinator` — Fastify HTTP + WS server
- `/health` returns `{ ok, subs, ts }` — useful sanity check.
- `/ws` accepts WebSocket subscribers and broadcasts every event published
  on the internal `EventBus`.
- 1Hz synthetic `heartbeat` so the dashboard (Track B, later) can build
  against the stream before Track A is filled in.
- `src/bus.ts` is the only thing that fans events out — Tracks A/D should
  publish through `bus.publish(evt)`. Subscribers come and go cleanly
  (auto-remove on socket close).

### `packages/llm/src/claude.ts` — single Claude entry point
**Every** Claude call in this repo goes through `chat()`. Why: the dashboard's
per-agent cost panel is sourced from these logs, and `prompt caching` only
pays off when it's centrally applied.

- Default model: `claude-haiku-4-5` (cheap, fast — matches hackathon p50 goal).
  Override per call with `model: "claude-sonnet-4-6" | "claude-opus-4-7"`.
- Prompt caching: opt-in via `cacheSystem: true`. Use it on stable system
  prompts (negotiation, agent role prompts).
- Logged per call: `{ model, inputTokens, outputTokens, cacheReadTokens,
  cacheWriteTokens, costUsd, latencyMs, promptHash, agentUri?, ts }`.
- `setClaudeLogSink(fn)` lets Track A redirect logs into the WS bus so the
  dashboard shows `llm.cost` events live. Default sink writes to stderr.
- `.env` is loaded by walking up from the package dir to find the workspace
  root — works no matter what cwd `pnpm --filter` runs from.

### Pricing table (USD per million tokens)
Hardcoded in `claude.ts`. Update when Anthropic pricing changes:

| Model              | input | output | cache read | cache write |
|--------------------|------:|-------:|-----------:|------------:|
| claude-haiku-4-5   | 1.00  | 5.00   | 0.10       | 1.25        |
| claude-sonnet-4-6  | 3.00  | 15.00  | 0.30       | 3.75        |
| claude-opus-4-7    | 15.00 | 75.00  | 1.50       | 18.75       |

## How to run / test

```bash
# Install
pnpm install

# Typecheck everything
pnpm -r typecheck

# Boot coordinator (port 8787 by default; override COORDINATOR_PORT)
pnpm coordinator

# Health check
curl http://localhost:8787/health

# Subscribe to the WS stream
node -e "const ws=new WebSocket('ws://localhost:8787/ws'); ws.onmessage=e=>console.log(e.data)"

# Verify Claude wrapper end-to-end (needs ANTHROPIC_API_KEY in .env at repo root)
pnpm --filter @ac/scripts exec tsx smoke-claude.ts
# expected output:
#   [sink] {"model":"claude-haiku-4-5",...,"costUsd":0.000062,"latencyMs":...}
#   text: Hi! <color>.
#   cost: $0.0000xx
```

## Workspace layout

```
.
├── apps/
│   └── coordinator/        # Track A lives here (Fastify + WS)
├── agents/                 # Track C agents land here
├── packages/
│   ├── contracts/          # the constitution
│   └── llm/                # Claude wrapper (metered)
├── scripts/
│   └── smoke-claude.ts     # live-call smoke test
├── plan.md                 # full plan
├── docs/phase-0.md         # you are here
├── .env.example
└── pnpm-workspace.yaml
```

## Env vars

| Var                  | Purpose                                                 |
|----------------------|---------------------------------------------------------|
| `ANTHROPIC_API_KEY`  | Required for any Claude call. From console.anthropic.com |
| `COORDINATOR_PORT`   | Default 8787                                            |
| `COORDINATOR_URL`    | Where agents post REST requests                         |
| `COORDINATOR_WS_URL` | Where the dashboard subscribes                          |
| `X402_HMAC_SECRET`   | Used by Track D to sign payment proofs                  |

## Smoke-test results captured at Phase 0 ship time

| Test                            | Result                                    |
|---------------------------------|-------------------------------------------|
| `pnpm -r typecheck`             | Clean across 3 packages                    |
| `pnpm coordinator` boot         | Listens on :8787 within ~1s                |
| `/health` GET                   | `{ok:true, subs:0, ts:...}`               |
| WS subscribe, 2.5s sample       | 4 heartbeat frames @ ~1Hz                  |
| Live Claude call (Haiku 4.5)    | 27in/7out, $0.000062, 983ms cold latency  |

## Next phase

**Solo build order**: A (coordinator state machine + metrics) → D (x402 mock +
receipts) → C (agent SDK + 6 agents) → B (dashboard) → Phase 3 (demo scenarios
+ polish). Track A is the next thing to start.

## Decisions deferred to Track A

- **Model choice per agent**: default Haiku 4.5 everywhere. Page-renderer
  (HTML generation) may need Sonnet 4.6 for quality — decide when building
  that agent based on a real bake-off, not a guess.
- **Reputation math**: `+0.05` on success, `−0.1` on failure, clamp to `[0,1]`
  (per plan.md "Notes for Claude"). Implemented in Track A.
- **metrics.tick window**: rolling 30s for p50/p95 felt right for demo scale.
  Confirm during Track A when there's real data to look at.
