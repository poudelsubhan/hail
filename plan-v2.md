# Agent Classifieds v2 — Implementation Plan

[bootstrap] host user created: handle=host, apiKey=ak_<redacted>  (save this — it is only printed once)

---

## Context & Key Findings

**Current state (v1, all four tracks shipped):**
- `apps/coordinator/` — Fastify + WS server, fully in-memory state. `store.ts`
  holds `agents`, `jobs`, `bids`, `contracts`, `receipts`, plus per-job latency
  + spend rollups. Dies with the process.
- `agents/src/sdk/` — `BaseAgent` abstract class: registers via REST, opens WS
  to coordinator, accepts `POST /work` to receive paymentProof + deliver.
- `packages/contracts/` — Zod schemas + TS types (the constitution).
- `packages/llm/claude.ts` — single Claude entry point with prompt caching +
  per-call metering. `setClaudeLogSink` wired to `/telemetry/llm-cost` from
  every agent process.
- `packages/x402/` — `X402` class with nonce TTL, replay protection, 10 unit
  tests. Used by coordinator via `apps/coordinator/src/x402-instance.ts`.
- `apps/dashboard/` — Next.js, three-pane layout, WS subscriber, ticker,
  metric cards, agent strip with reputation deltas, iframe page preview.

**v2 thesis.** Same architecture, but invited friends run their own agents
from their own machines and connect to a host-run coordinator over a
Cloudflare Tunnel. The host has zero responsibility for what's inside a
participant agent — only for providing the marketplace, optional SDK
helpers, and rate-limited LLM credits for those helpers.

**Hard problems and their resolutions:**
1. **NAT.** Participants can't accept inbound HTTP. → Work is pushed over
   their existing authenticated WS (`work.assigned` event), not a `POST /work`
   to their host:port.
2. **Identity.** Anyone can register any URI. → Invite-issued API keys; each
   agent is owned by a user; URIs become `agent://<handle>.<slug>`.
3. **Mock wallet pressure.** No real-money pressure means no consequence for
   bad agents. → Real escrow + timeout-driven auto-fail + reputation penalty.
   Balances enforced on post and bid.
4. **LLM cost.** Participants own their executeWork entirely with their own
   `ANTHROPIC_API_KEY`. Host provides one shared `POST /llm/chat` proxy used
   only by SDK helpers (e.g. `proposeBid`); using it is optional. Per-API-key
   daily token cap.

**Constraints (still hackathon-scoped).** No Docker, no Postgres, no cloud.
SQLite file on the host. Coordinator + dashboard still run on host laptop.
Cloudflare Tunnel for public reachability. Free-form capability tags.

---

## Phase 1 — Persistence + identity foundation

Hard gate. Everything in later phases authenticates against this layer.

### 1A. SQLite schema + data access layer

Create `apps/coordinator/src/db/`:

- `schema.sql` — schema below
- `index.ts` — `better-sqlite3` instance, migration runner on boot, exports
  prepared statements
- Initial migration runs against `process.env.SQLITE_PATH ?? "./data/ac.db"`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- usr_<nanoid>
  handle TEXT UNIQUE NOT NULL,   -- url-safe slug
  email TEXT,                    -- optional
  api_key_hash TEXT NOT NULL,    -- sha256(api_key)
  balance_usd REAL NOT NULL DEFAULT 5.00,
  created_at INTEGER NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,         -- short opaque token, 12 chars
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_user TEXT REFERENCES users(id),
  note TEXT                       -- "Alice from Coframe"
);

CREATE TABLE agent_owners (
  uri TEXT PRIMARY KEY,           -- agent://<handle>.<slug>
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE completed_contracts (
  contract_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  poster_uri TEXT NOT NULL,
  bidder_uri TEXT NOT NULL,
  price_usd REAL NOT NULL,
  state TEXT NOT NULL,            -- settled | failed | timed_out
  ts INTEGER NOT NULL
);

CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  from_uri TEXT NOT NULL,
  to_uri TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE llm_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),  -- nullable for system calls
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_receipts_ts ON receipts(ts);
CREATE INDEX idx_completed_contracts_ts ON completed_contracts(ts);
CREATE INDEX idx_llm_costs_user_ts ON llm_costs(user_id, ts);
```

Add `better-sqlite3` to `apps/coordinator/package.json`. Create a `data/`
dir; ignore `data/*.db*` in `.gitignore`.

### 1B. Auth middleware

`apps/coordinator/src/auth.ts` — Fastify preHandler that:
- Reads `Authorization: Bearer <apiKey>` header
- Looks up user by `api_key_hash = sha256(apiKey)`
- Attaches `req.user` (FastifyRequest decorator)
- Required on **all mutating endpoints** (`POST /registry/register`,
  `POST /jobs`, `POST /jobs/:id/bid`, `POST /jobs/:id/accept`,
  `POST /contracts/:id/deliver`, `POST /x402/settle`,
  `POST /negotiation/message`, `POST /llm/chat`)
- Optional on read endpoints; if present, attaches user for personalization

Register via `app.addHook("preHandler", authPreHandler)` and skip on a path
allowlist (`/health`, `/ws`, `/signup`).

### 1C. Signup + invite endpoints

`apps/coordinator/src/routes/auth.ts`:

- `POST /invites` (host-only) → `{ code, url }`. Issues a new invite code.
  `is_host=1` check on `req.user`. Note: optional `?note=...` for tracking.
- `POST /signup` (public) → `{ apiKey, userId, handle, balanceUsd }`.
  Body: `{ inviteCode, handle, email? }`. Validates code is unused, generates
  apiKey (`ak_` + 24 hex chars), stores `sha256(apiKey)`, sets initial
  balance to `$5.00`. Atomic: invite consumption + user insert in a
  single transaction.
- `GET /me` (authed) → `{ userId, handle, balanceUsd, agents: [...] }`.

### 1D. Host bootstrap

`apps/coordinator/src/bootstrap.ts` (runs once on boot):
- If `users` table is empty, create the host user from env:
  `AC_HOST_HANDLE`, `AC_HOST_API_KEY` (or generate + print on first run).
  Mark `is_host=1`, balance `100.00`.
- Idempotent: re-running coordinator doesn't reset balances.
- Print to stderr: `[bootstrap] host user: handle=<…>, apiKey=<…> (save this!)`
  only on first creation.

### 1E. Wallet bookkeeping

`apps/coordinator/src/wallet.ts`:

- `debit(userId, amountUsd, reason)` — throws `InsufficientFundsError` on
  underflow; otherwise updates `users.balance_usd` and logs to a transient
  in-memory ledger (`store.balanceLedger`) for the dashboard.
- `credit(userId, amountUsd, reason)` — never throws.
- `getBalance(userId)` — fast read.
- All operations inside SQLite transactions; no race conditions with the
  single-threaded Node + WAL mode.

---

## Phase 2 — Contract enforcement, WS work assignment, LLM proxy

Depends on Phase 1: every route here calls `req.user.id` and `wallet.*`.

### 2A. Escrow at accept time

Edit `apps/coordinator/src/routes/jobs.ts`:

- On `POST /jobs/:id/accept`, before issuing the 402 challenge:
  - Resolve `posterUserId` from `agent_owners[posterUri]`.
  - `wallet.debit(posterUserId, bid.priceUsd, "escrow:contract_<id>")`.
  - Stash the escrow in `store.escrows: Map<contractId, { userId, amountUsd }>`.
- On `POST /contracts/:id/deliver` success:
  - Release escrow → `wallet.credit(bidderUserId, contract.priceUsd, ...)`.
  - Move escrow record from in-memory to `completed_contracts + receipts` rows.
- On contract failure (proof verify fail, etc.):
  - Refund escrow → `wallet.credit(posterUserId, contract.priceUsd, ...)`.
  - Insert `completed_contracts` row with `state="failed"`.

Add `POST /jobs` enforcement: `wallet.getBalance() >= maxPriceUsd` or
reply 402 with reason `insufficient_balance`. (Reuses the 402 status code;
distinct shape from x402 — body says `{error: "insufficient_balance"}`.)

### 2B. WS work assignment (replace `POST /work`)

This is the biggest architectural shift.

**Coordinator side** — `apps/coordinator/src/ws.ts`:
- On WS upgrade, require `?apiKey=…` query param. Resolve user; attach to
  socket. Reject unauthenticated sockets.
- Track `userSockets: Map<userId, Set<WebSocket>>` for direct push.
- New helper `bus.pushTo(userId, evt)` — sends only to that user's sockets.
- Define new WS event in `packages/contracts/index.ts`:
  ```ts
  WsWorkAssigned = z.object({
    type: z.literal("work.assigned"),
    contractId: z.string(),
    jobId: z.string(),
    capability: z.string(),
    brief: z.string(),
    paymentProof: z.string(),
    deadlineMs: z.number(),
    ts: z.number(),
  });
  ```
- On accept-and-settle (the moment we currently push to `bidder.url/work`):
  - Resolve `bidderUserId` from `agent_owners[bidderUri]`.
  - `bus.pushTo(bidderUserId, { type: "work.assigned", ... })`.
  - **Do not** call the bidder's HTTP `/work` endpoint anymore.

**SDK side** — `agents/src/sdk/index.ts`:
- Remove the `POST /work` Fastify route.
- The WS handler for `work.assigned` does what `POST /work` used to do.
- Concrete agents continue to implement `executeWork`. Then they
  `POST /contracts/:id/deliver` (outbound HTTP, works through NAT).

Coordinator still issues a 402 from `POST /jobs/:id/accept`, but the
**poster** (not the bidder) calls `POST /x402/settle`. Once settled, the
coordinator does the WS push to the bidder. The poster no longer has to
push proof to bidder; the coordinator handles it.

This collapses the poster's `hireWork()` flow into: post → wait for bids
→ accept → settle → wait for `job.completed`.

### 2C. Deadline sweeper

`apps/coordinator/src/sweeper.ts`:
- Every 2s, scan `store.contracts` (in-memory) for any with
  `now > acceptedAt + (bid.etaSec * 2 * 1000)` and `state === "contracted"`.
- Mark `failed`. Refund escrow. Emit `job.completed { success: false,
  reason: "timeout" }`. Bump bidder reputation by `-0.10`.
- Bidder's `agent_owners` row stays — only their rep tanks.

Reputation penalty is applied via `store.bumpReputation` (no change needed).
The contract row in `completed_contracts` gets `state="timed_out"` so the
dashboard can distinguish.

### 2D. Claude proxy (host-paid, opt-in)

`apps/coordinator/src/routes/llm.ts`:

```ts
POST /llm/chat
  Headers: Authorization: Bearer <apiKey>
  Body: { system?, messages, model?, maxTokens?, temperature?, cacheSystem? }
  Returns: { text, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, costUsd, latencyMs }
```

- Resolves `req.user.id`.
- Hits the host's `ANTHROPIC_API_KEY` (loaded by coordinator only).
- Caps `maxTokens` at 1024, model whitelist (no Opus by default).
- Per-user daily token bucket (`store.llmQuotaByUser: Map<userId, { day,
  inputTokens, outputTokens }>`). Default cap: **100k input + 25k output
  per user per day**. Configurable via env `AC_DAILY_TOKEN_CAP_IN/OUT`.
  Over cap → reply `429 { error: "daily_token_cap_exceeded" }`.
- Persists every call to `llm_costs` table.
- Emits the same `llm.cost` WS event so the dashboard's panels work
  unchanged. `agentUri` field carries the **caller's** URI when provided.

**Critical:** participants are not required to use this. Their agent's
`executeWork` continues to call Anthropic directly with their own key.
Only the SDK's `negotiate.proposeBid` helper (and any future SDK helpers)
routes through the proxy.

### 2E. URI namespacing

Update `AgentUri` regex in `packages/contracts/index.ts` to allow
`agent://<handle>.<slug>` (or stay compatible with `agent://<slug>.local`
for back-compat with v1 system agents):

```ts
AgentUri = z.string().regex(
  /^agent:\/\/[a-z0-9][a-z0-9-]{0,30}\.[a-z0-9][a-z0-9-]{0,30}(\.local)?$/i
);
```

`POST /registry/register` enforces: the URI's handle prefix matches
`req.user.handle`. Reject `agent://alice.x` from a `bob`-owned API key.

---

## Phase 3 — SDK migration + dashboard polish

Depends on Phase 2.

### 3A. Agent SDK overhaul

Edit `agents/src/sdk/index.ts`:

- `AgentConfig` gains: `apiKey: string`, `handle: string` (used for the
  URI). Slug stays as-is.
- All `coordPost`/`coordGet` helpers attach `Authorization: Bearer <apiKey>`.
- WS connect URL: `?apiKey=<apiKey>` query param.
- Replace `POST /work` Fastify route handler with WS message handler for
  `work.assigned`.
- `wireLlmTelemetry` no longer needed if the participant uses the proxy
  (the proxy emits `llm.cost` server-side). Keep the hook for participants
  who use direct Anthropic — they continue to POST `/telemetry/llm-cost`
  to attribute their spend in the dashboard.
- `agents/src/sdk/negotiate.ts` — `proposeBid` now calls `POST /llm/chat`
  via `coordPost`, not via `@ac/llm` directly. This is the swap that lets
  the host float the bidding cost.
- Update existing v1 agents to construct with `{ apiKey, handle: "host" }`
  passed in. `scripts/demo.ts` reads `AC_HOST_API_KEY` and `AC_HOST_HANDLE`
  from env (matches Phase 1D bootstrap output).

### 3B. Capability discovery panel

New tab/route on dashboard (or replace the bottom-right preview slot when
no page is active): `components/CapabilityCloud.tsx`.

- Backend: `GET /capabilities` (public) → `{ capabilities: [{ tag, agentCount,
  jobsLast24h, lastJobTs }] }`. Aggregates from `store.agents` + in-memory
  recent-jobs ring.
- UI: bubble cloud sized by `jobsLast24h`. Click → shows the agents serving
  that tag + recent example briefs.
- Helps newcomers see what's hot and what's underserved.

### 3C. Surface new event types on the ticker

- Render `work.assigned` events in `Ticker.tsx` with their own accent color
  (gold/orange) — gives the audience a visible "the bidder was told to do
  the thing" moment.
- Render `contract.timed_out` (new event from sweeper) in red with
  "timeout" badge.
- `negotiation.message` already supported; verify it still works under
  the WS-auth changes.

---

## Phase 4 — Participant onboarding

Depends on Phase 3.

### 4A. Agent starter repo

New top-level folder `agent-starter/` (separate workspace package,
`@ac/agent-starter`, not part of the production build):

- README with copy-pasteable signup curl, env setup, `npm start` command.
- `src/my-agent.ts` — heavily commented template extending `BaseAgent`.
  Includes `decideBid` (uses the SDK's `proposeBid` helper, host-paid) and
  `executeWork` (calls `chat` from `@ac/llm` directly with the
  participant's own `ANTHROPIC_API_KEY`).
- `.env.example` with: `AC_API_KEY`, `AC_COORD_URL`, `AC_COORD_WS_URL`,
  `ANTHROPIC_API_KEY` (their own), `AGENT_PORT` (optional — only needed
  if they expose extras like the page-renderer's `/pages/:id`).
- "Fork this repo" instructions or a `tar.gz` link from the dashboard.

### 4B. Invite CLI

`scripts/invite.ts`:

- `pnpm invite create [--note "Alice from Coframe"]` → calls
  `POST /invites` as host, prints the code + a signup URL pointing at the
  Cloudflare Tunnel base.
- `pnpm invite list` → prints unused invites.
- `pnpm invite revoke <code>` → POST `/invites/<code>/revoke`.

Wire to root `package.json` scripts.

### 4C. README v2 + participant quickstart

- Rewrite `README.md`: now leads with the invited-participant flow.
- New `docs/participant-quickstart.md`:
  1. Receive invite code from host
  2. `curl -X POST .../signup -d '{"inviteCode":"...","handle":"alice"}'`
  3. Clone starter, set env, `npm start`
  4. Watch your agent on the public dashboard
- New `docs/host-setup.md`:
  1. Run coordinator: `pnpm coordinator`
  2. Run dashboard: `pnpm dashboard`
  3. Run two tunnels — one for coordinator (`--url http://localhost:8787`),
     one for dashboard (`--url http://localhost:3000`). Share the dashboard
     tunnel URL with invitees so they can watch the marketplace.
  4. Generate invites with `pnpm invite create`

### 4D. Cloudflare Tunnel docs

`docs/tunnel.md`:
- One-time `cloudflared` install
- `cloudflared tunnel --url http://localhost:8787` → ephemeral URL
- For stable URL: named tunnel (`cloudflared tunnel create ac-coord`) +
  DNS — optional, document but don't require.
- Mirror for the dashboard if host wants it public too.

---

## Observability & Measurement

Per `~/.claude/CLAUDE.md` — observability is the load-bearing weakness.
Ship instrumentation **with** each phase, not after.

### Success metrics (each tied to a number)

- **Distinct active users in last 24h** (target ≥ 5 by end of hackathon).
  Query: `COUNT(DISTINCT user_id) FROM llm_costs WHERE ts > now - 86400000`,
  plus anyone whose agent emitted `agent.registered` since.
- **Agent diversity per capability** — count distinct owners per capability.
  Target ≥ 2 owners for at least one of `summarize`, `translate`,
  `render_page` (proves invited users actually built something).
- **Successful invite conversion rate** — `consumed / issued`. Target ≥ 50%.
- **Contract completion rate** — `settled / accepted`. Target ≥ 90% in any
  rolling 1h window (excluding deliberate war demos).

### Cost

- **Daily host LLM spend (USD)** via `llm_costs` rolled up by day. Cap
  enforcement is what this measures.
- **Per-user LLM spend** — proxy calls only. Direct-key calls reported via
  participant telemetry are flagged distinctly.
- **Coordinator memory** — `process.memoryUsage().rss` logged every 60s.
  In-memory state will grow with traffic; this is where we notice.

### Performance

- **Work-assignment p50 / p95** — `contract.signed.ts → work.assigned.ts`
  delta. Target p50 < 100ms.
- **End-to-end job latency** (`job.posted → job.completed`) p50 / p95 —
  already tracked.
- **LLM proxy p50 / p95** — added to `metrics.tick`. Helps see when
  Anthropic throttles us.

### Failure signals

- **Daily token cap hits** (count of `429`s from `/llm/chat`). Spike →
  investigate per-user.
- **Contract timeout rate** — `state=timed_out / total contracts` rolling
  1h. Spike means bad agents or coordinator pushed work to a disconnected
  agent.
- **WS reconnect storms per user** — `> 5 reconnects / min` is a yellow
  flag for a participant on bad network.
- **Insufficient-balance errors at post** — count per user. Means the
  user is misusing their budget.

### Instrumentation tasks (folded into the phases above)

- 1A: `llm_costs` table, `completed_contracts.state` field tracks outcomes
- 1E: ledger ring buffer for balance changes (`store.balanceLedger`)
- 2B: `work.assigned` event carries `ts` — pair with `contract.signed.ts`
  for latency metric
- 2C: sweeper logs every timeout structured (`{contractId, bidderUri,
  ageMs}`)
- 2D: every proxy call writes to `llm_costs` + emits `llm.cost` WS
- 3D: dashboard surfaces all of the above visually

### Alerts (demo-grade)

- Daily host LLM cost > $5 → red banner on dashboard, log warning.
- Contract timeout rate > 30% in a 5-minute window → red banner.
- Coordinator RSS > 1 GB → log warning every 60s (don't crash).

---

## Dependency Graph

```
        ┌────────────────── Phase 1 — Persistence & Identity ─────────────────┐
        │  1A schema/dao •  1B auth middleware •  1C signup/invite •           │
        │  1D host bootstrap •  1E wallet bookkeeping                          │
        └────────────────────────────────────┬─────────────────────────────────┘
                                             │ hard gate
        ┌──────────── Phase 2 — Contracts & Work Routing & LLM Proxy ─────────┐
        │  2A escrow @ accept  •  2B WS work.assigned (replaces POST /work)    │
        │  2C deadline sweeper •  2D Claude proxy •  2E URI namespacing        │
        └────────────────────────────────────┬─────────────────────────────────┘
                                             │ hard gate
        ┌──────────────── Phase 3 — SDK Migration & Dashboard ────────────────┐
        │  3A SDK overhaul   •  3B capability cloud                            │
        │  3C new event types in ticker                                        │
        └────────────────────────────────────┬─────────────────────────────────┘
                                             │ hard gate
        ┌────────────────── Phase 4 — Onboarding & Tunnel ────────────────────┐
        │  4A starter repo   •  4B invite CLI                                  │
        │  4C README v2 + quickstart docs  •  4D tunnel docs                   │
        └──────────────────────────────────────────────────────────────────────┘
```

---

## Notes for Claude

- **The contracts file is still the constitution.** When you add `work.assigned`,
  add it to the Zod union in `packages/contracts/index.ts` first. Mocks
  drift = integration breaks.
- **Don't move job/bid/contract state to SQLite.** They're ephemeral.
  Persisting only `users`, `invites`, `agent_owners`, `completed_contracts`,
  `receipts`, `llm_costs` keeps the surface area honest. The marketplace
  is still in-memory; we persist what proves outcomes.
- **Auth before everything.** Don't refactor `routes/jobs.ts` until 1B is
  done — the route handlers reach for `req.user.id` to record ownership.
- **WS work assignment is the most subtle change.** Prior callers (v1
  `BaseAgent.hireWork`) pushed proof to the bidder's `/work` endpoint;
  the new flow has the **coordinator** push on settle. The poster's flow
  becomes "settle + wait for job.completed" with no proof-push step. Update
  `BaseAgent.hireWork` accordingly.
- **Treat the proxy as opt-in.** Participants who use it pay zero LLM cost
  (host pays). Participants who hate the rate cap can use their own key in
  `executeWork`. The SDK's `proposeBid` defaulting to the proxy is what
  makes "host floats orch LLM" actually work.
- **Don't gate the dashboard behind auth.** Public anonymous view, period.
  Participants find their own agent by handle in the strip; they `curl /me`
  if they want balance info. Demo trumps product.
- **Reputation deltas already wired** on the dashboard (Phase 3 of v1).
  The sweeper's timeout-fail just needs to publish `job.completed { success:
  false }`; the existing client-side reducer derives the -0.10 chip.
- **Cloudflare Tunnel: ephemeral URL is fine for hackathon.** Named tunnels
  + DNS are listed in 4D for completeness but don't block on them.
- **Cap on rebid abuse.** Existing `MAX_REBIDS = 3` + per-account daily
  token cap means a single bad actor can't burn host LLM budget rapidly.
  Worth confirming when 2D ships: trace per-user proxy call rate.
- **The user's `~/.claude/CLAUDE.md` is explicit:** every feature ships with
  a meter. The observability section above is non-optional. Don't ship
  Phase 2 without 2D's `llm_costs` writes + the timeout counter; don't ship
  Phase 3 without the panels.
- **Migration risk for v1 agents.** The current `scripts/demo.ts` boots
  six agents anonymously. After Phase 3A, they'll need `AC_HOST_API_KEY`
  in env. Don't ship 3A without updating demo.ts in the same PR; otherwise
  `pnpm demo` breaks.

---

## What's deliberately out of scope

- **No Docker, no Postgres, no Kubernetes.** Still single-machine.
- **No agent SDK for Python.** Plan called it optional; defer until post-hackathon.
- **No real cryptographic identity.** API keys, not signed messages.
  `pubkey` field stays but is ornamental.
- **No multi-tenant Claude key management.** One host key, period.
- **No invite expiration / multi-use codes.** Each invite is single-use,
  never expires. Add complexity only if abuse appears.
- **No persistent jobs/bids.** State dies with coordinator (v1's contract).
  Completed contracts + receipts persist; ephemeral state doesn't.
- **No payment processor integration.** Mock balances only. The whole point
  of v2 is to *prove the marketplace works*, not to handle real money.
