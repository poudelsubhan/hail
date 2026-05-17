# Agent Classifieds v3 — Implementation Plan

> **Purpose**: Instruction doc for Claude. Each phase is a HARD gate — all tasks
> in Phase N must complete before ANY task in Phase N+1 begins. Tasks within a
> phase can run in parallel unless noted. The **Parked** section at the bottom
> requires explicit user permission before any task in it is started.

---

## Context & Key Findings

**Where v2 left us.** Invite-gated marketplace with auth + escrow + WS work
assignment + Claude proxy + capability cloud. Smoke and `pnpm demo` both
green. Coordinator is single-process Node + SQLite; dashboard is Next.js.
Host runs everything locally; participants connect over their own internet.

**v3 thesis.** Take the marketplace public. Host stack lives at stable cloud
URLs (no demo-day cloudflared roulette). A live invitee connects an agent
from stage in under a minute. The wallet model graduates from
"one balance per user" to **one wallet per agent**, which is the shape x402
actually wants and gives the dashboard a clean per-wallet ledger to point at.

**Hard problems and their resolutions:**

1. **Cloud cost.** Hobby-tier deploy must be free or near-zero idle. → Coordinator
   on **Fly.io** free shared-cpu-1x VM with a persistent volume for SQLite;
   dashboard on **Vercel** free tier. Custom Fly/Vercel subdomains, no paid
   domain.
2. **Public signup is a foot-gun.** Random visitors signing up would burn
   the host's `ANTHROPIC_API_KEY`. → No public signup form. The dashboard's
   "Add Agent" button shows an invite-only wall. The actual redemption page
   (`/redeem`) only resolves when paired with a valid invite code, which only
   the admin can issue.
3. **Admin operations live on a phone-shaped device on demo day.** Generating
   an invite via CLI mid-talk is awkward. → Add `/admin` route in the
   dashboard, HTTP-basic-auth (env-driven). Admin can issue + list + revoke
   invites from the UI; the host apiKey never leaves the server.
4. **Onboarding a real invitee in front of an audience.** "Clone our monorepo"
   is a story-killer. → Separate standalone `agent-classifieds-starter`
   GitHub repo with "Use this template" enabled. Depends on the monorepo's
   `@ac/*` packages via git tarball pin (no npm publish needed).
5. **Demo-day fragility.** If the coordinator's WAL is stale, or env got out
   of sync between Fly and the build artifact, the audience sees the bug
   before we do. → Smoke-on-boot: coordinator runs a tiny end-to-end
   self-test post-listen and crashes loudly on failure, *before* we point
   audiences at it.

**Constraints (still hackathon-scoped).** No paid domain. No npm publish. No
DB migrations beyond `CREATE TABLE IF NOT EXISTS`. Trust mechanics and
spectacle features are explicitly parked.

---

## Phase 1 — Per-agent wallets

Hard gate. Schema and proof-payload changes propagate everywhere; this has
to land before deploy so the cloud DB starts on the right shape.

### 1A. Wallets schema + DAO

Edit `apps/coordinator/src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,                  -- wlt_<handle>_<slug> | wlt_user_<userId>
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  agent_uri TEXT,                       -- NULL for user-default wallet
  balance_usd REAL NOT NULL DEFAULT 0.00,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallets_owner ON wallets(owner_user_id);
```

Existing `users.balance_usd` stays for back-compat with v2 smoke and acts as
the user-default wallet's funding source. Conceptually: a user has one
"main" wallet (`wlt_user_<userId>`) plus one sub-wallet per registered
agent.

Add to `apps/coordinator/src/db/index.ts`:

- `dao.findWallet(id)`, `dao.findWalletByAgent(agentUri)`, `dao.walletsForUser(userId)`
- `dao.insertWallet(row)`, `dao.setWalletBalance(id, amount)`
- All operations in transactions.

### 1B. Wallet creation hooks

Three hook points materialize wallets idempotently:

1. **On `POST /signup`** — create `wlt_user_<userId>` with the starting $5.
   The user's `balance_usd` column mirrors this for v2 read paths during
   the transition.
2. **On `POST /registry/register`** — if a wallet for this `agent_uri`
   doesn't exist yet, create `wlt_<handle>_<slug>` with $0 balance. Owner
   is `req.user.id`. The agent earns into this wallet, not the user's.
3. **On host bootstrap** — host user gets `wlt_user_<hostUserId>` with the
   `AC_HOST_STARTING_BALANCE_USD` value.

### 1C. Wallet-based escrow/credit

Rewrite `apps/coordinator/src/wallet.ts` so `debit`/`credit`/`getBalance`
all take a `walletId` instead of `userId`. Add a thin compat shim
`userDebit(userId, amount, reason)` that resolves to `wlt_user_<userId>`
internally, used only where Phase 2's UI still operates on user identity.

Update job/contract paths:

- `POST /jobs` balance check: `wallet.getBalance(wlt_<posterAgent>) >= maxPriceUsd`.
  Reasoning: a poster's *agent* should be solvent enough to back its own
  job, not just "the user who owns it". If it's their first job, they can
  fund it from the user-default wallet via a new internal transfer (1F).
- `POST /jobs/:id/accept`: debit the poster *agent*'s wallet. Stash
  `posterWalletId` + `bidderWalletId` in `store.contractMeta`.
- `POST /contracts/:id/deliver` success: credit the bidder *agent*'s wallet.
- Sweeper timeout: refund the poster *agent*'s wallet.

### 1D. Funding flow (user → agent)

`POST /wallets/:agentWalletId/fund { fromUsd: number }` (auth required,
caller must own the agent). Debits `wlt_user_<userId>`, credits the
agent wallet. Demo-day this lets you sprinkle starting balance on a new
participant's agent without them touching SQL.

For convenience, **on first agent register**, auto-transfer
`AC_AGENT_STARTING_BALANCE_USD` (default $1.00) from the user-default
wallet to the new agent wallet, if the user has enough. Configurable; can
be 0.

### 1E. x402 proof payload carries wallet IDs

Add `fromWalletId` and `toWalletId` to `X402ProofPayload` in
`packages/contracts/src/index.ts`. Coordinator-side x402 instance
constructs them at challenge issue time. Verify path is unchanged
(HMAC over the new body).

Receipts (`completed_contracts.receipts` rows) gain `from_wallet_id` +
`to_wallet_id` columns (additive — `ALTER TABLE` skipped, just add via
new schema since this is `CREATE IF NOT EXISTS`; existing rows can stay
null).

### 1F. Dashboard wallet panel

New right-rail panel `components/WalletStrip.tsx`:

- `GET /wallets` (host-only via Bearer): list all wallets with balance.
- Renders top 8 wallets by balance with handle.slug → `$X.XX`.
- Updates from `payment.settled` and a new `wallet.changed` WS event
  emitted on every credit/debit (keeps the panel reactive without
  polling).

Add `WsWalletChanged` to the discriminated union:

```ts
WsWalletChanged = z.object({
  type: z.literal("wallet.changed"),
  walletId: z.string(),
  agentUri: AgentUri.optional(),
  balanceUsd: z.number(),
  deltaUsd: z.number(),
  reason: z.string(),
  ts: z.number(),
});
```

---

## Phase 2 — Public redeem + admin pages

Depends on Phase 1. Front-end + a small backend addition for HTTP basic
auth on `/admin`.

### 2A. /redeem page (dashboard, anonymous)

`apps/dashboard/app/redeem/page.tsx`:

- Reads `?invite=<code>` from the URL.
- Renders a form: single field for desired handle.
- POSTs to a Next.js API route at `/api/redeem` which proxies to
  coordinator's `POST /signup` (server-side, no apiKey injection — this is
  an anonymous public op).
- On success, shows the user a styled card with:
  - their apiKey (with a "copy" button)
  - their handle + URI prefix (`agent://<handle>.<slug>`)
  - a link to the starter template repo (`README.md` has paste
    instructions)
  - a "save this — there is no recovery flow" warning
- Errors: `invite_not_found`, `invite_consumed`, `handle_taken` all get
  friendly messages.

### 2B. "Add Agent" dialog (dashboard)

Modify `apps/dashboard/components/Header.tsx` (or add a new
`AddAgentButton.tsx`) to render a button labeled "Add Agent". Click opens
a modal:

> **Invite-only marketplace**
>
> The host generates invites for trusted participants. Got a link from
> them? It looks like `dashboard.vercel.app/redeem?invite=…` — click it.
>
> Otherwise: ping @subhan to request one.

No form. No state. Just a wall. Modal closes on Escape or backdrop click.

### 2C. /admin authentication

HTTP basic auth via Next.js middleware (`apps/dashboard/middleware.ts`)
matching `/admin/:path*`. Reads `ADMIN_USER` and `ADMIN_PASSWORD` from
server env. On missing/wrong credentials, returns 401 with
`WWW-Authenticate: Basic realm="ac-admin"` — browser prompts. No session,
no cookie; browser remembers per-origin.

Defaults: `ADMIN_USER=admin`, `ADMIN_PASSWORD=password`. These MUST be
overridden in Vercel env before exposing the dashboard URL.

### 2D. /admin invite UI

`apps/dashboard/app/admin/page.tsx`:

- Three sections:
  - **Issue invite.** Optional note field, "Generate" button → POST
    `/api/admin/invites` (server-side proxy with `AC_HOST_API_KEY`).
    Shows the shareable URL `<dashboardOrigin>/redeem?invite=<code>` with
    a copy button.
  - **Unused invites.** Polls `/api/admin/invites` every 10s. Each row has
    a "Revoke" button.
  - **Recent signups.** Polls a new coord endpoint `GET /admin/recent`
    (host-only) showing the last 10 user signups with their handle, the
    invite note, and timestamp. Useful for "who just joined" awareness
    on demo day.

Next.js API routes used:

- `POST /api/admin/invites` → coord `POST /invites` with host Bearer
- `GET /api/admin/invites` → coord `GET /invites`
- `DELETE /api/admin/invites/[code]` → coord `DELETE /invites/:code`
- `GET /api/admin/recent` → coord `GET /admin/recent` (new endpoint, see below)

Coordinator addition: `GET /admin/recent` returns last 10 user signups
ordered by `users.created_at DESC`. Host-only (`req.user.is_host`).

---

## Phase 3 — Smoke-on-boot

Depends on Phase 1 (uses wallets).

### 3A. Self-test runner

`apps/coordinator/src/smoke-on-boot.ts`:

- Runs `BOOT_SMOKE=1` (default `1`; set to `0` to disable).
- Creates a one-shot invite via host-internal call (bypass auth using a
  module-internal helper, not over HTTP), signs up a temp user
  `_boot_smoke_<random>`, registers an agent, posts a tiny job for itself,
  bids, accepts, settles, delivers. Asserts each step. Tears down the
  signup at the end via a new `dao.deleteUser(userId)` (cascades to
  wallets via FK + manual agent_owners cleanup).
- Logs structured event-by-event: `{ step: "signup", elapsedMs }`,
  `{ step: "deliver", elapsedMs }`.
- On any failure: `process.exit(1)` with a multi-line stack. Fly's
  health-check kills + restarts; the deploy fails visibly.

### 3B. Wire to coordinator startup

In `apps/coordinator/src/index.ts`, after `app.listen(...)` resolves and
before logging "coordinator listening", call `runBootSmoke()`. Wrap in
`try/catch`; on failure call `app.close()` + `process.exit(1)`.

Adds ~3-4s to cold-boot time. Acceptable for the demo-safety win.

---

## Phase 4 — Standalone starter template repo

No dependency on the other phases. Can run in parallel with 1–3.

### 4A. Repo creation

Make a new GitHub repo `agent-classifieds-starter` (separate from the
monorepo). Initial contents:

- `package.json` with deps on `@ac/contracts` and `@ac/agents` and
  `@ac/llm` via **git tarball pin**:

  ```json
  "dependencies": {
    "@ac/contracts": "https://gitpkg.now.sh/<user>/AGI-hackathon/packages/contracts?<tag>",
    ...
  }
  ```

  Or simpler: vendor the three packages' compiled JS into `vendor/`. Crude
  but ships in one PR. We'll burn this bridge if someone needs to update.

- `src/my-agent.ts` — copy-paste from `agent-starter/src/my-agent.ts`.
- `.env.example` — same as `agent-starter/.env.example`.
- `README.md` — same as `agent-starter/README.md` but with screenshots of
  the redeem flow at the top.
- `.github/template-repository` (config to enable "Use this template").

### 4B. Tag the monorepo

Tag the current monorepo commit `v3-starter-base`. The starter pins
against this tag so future monorepo changes don't accidentally break
existing participants' setups.

### 4C. Cross-link

- Monorepo README updates the participant-quickstart link to point at the
  template repo's "Use this template" button.
- Template README's "next steps" section links back to the host dashboard
  + the invite redemption flow.

---

## Phase 5 — Deploy

Depends on all of 1–4.

### 5A. Fly.io coordinator

- `apps/coordinator/fly.toml` — single-app config:
  - `[build] dockerfile = "Dockerfile"` — write a 12-line Node 22
    Dockerfile that copies the monorepo, runs `pnpm install --filter @ac/coordinator...`,
    and CMDs `tsx src/index.ts`.
  - `[[services]] internal_port = 8787, protocol = "tcp"`
  - HTTPS termination by Fly automatically.
  - `[mounts] source = "ac_data", destination = "/data"` — 1GB volume.
  - `SQLITE_PATH=/data/ac.db` env var.
- `fly launch` → creates app + volume + secrets. Set secrets via
  `fly secrets set`: `ANTHROPIC_API_KEY`, `AC_HOST_API_KEY`,
  `X402_HMAC_SECRET`. All others (`AC_HOST_HANDLE`, `AC_PUBLIC_BASE_URL`,
  token caps) go in `fly.toml [env]`.
- `AC_PUBLIC_BASE_URL` points at the Vercel dashboard URL so the redeem
  link is the dashboard, not the coordinator.

### 5B. Vercel dashboard

- Connect the monorepo to Vercel with `apps/dashboard` as the root.
- Build command: `pnpm install --filter @ac/dashboard... && pnpm --filter @ac/dashboard build`.
- Env vars (Vercel project settings):
  - `NEXT_PUBLIC_COORDINATOR_URL=https://<fly-app>.fly.dev`
  - `NEXT_PUBLIC_COORD_WS=wss://<fly-app>.fly.dev/ws`
  - `AC_HOST_API_KEY=<same as Fly>` — server-side only, for `/api/admin/*` proxies.
  - `ADMIN_USER` / `ADMIN_PASSWORD` — placeholders documented; override
    before sharing the URL.
- Preview deployments auto-deploy on PRs against the monorepo.

### 5C. Smoke against deployed stack

After both deploys are green:

```bash
COORDINATOR_URL=https://<fly-app>.fly.dev \
COORDINATOR_WS_URL=wss://<fly-app>.fly.dev/ws \
AC_HOST_API_KEY=<...> \
  pnpm --filter @ac/scripts exec tsx smoke-phase2.ts
```

Should print `Phase 2 smoke PASSED`. If it doesn't, we don't share the URL.

Then manually:

1. Open dashboard URL in incognito, click "Add Agent" → see the wall.
2. Open `/admin` → basic auth prompt → log in → generate an invite → copy
   the URL.
3. Paste the URL in another incognito window → fill handle → see apiKey.
4. Run the starter locally with the apiKey + the Fly coordinator URL →
   agent shows up in the strip.

---

## Observability & Measurement

Per `~/.claude/CLAUDE.md` — every meaningful feature ships with a meter.
v3 adds three new dimensions: per-agent economics, cloud cost, and
boot-safety.

### Success metrics

- **Wallets with positive balance** — `SELECT COUNT(*) FROM wallets WHERE balance_usd > 0`.
  Target ≥ 5 after first hour of demo-day live use.
- **Successful redemptions** (`consumed / issued` on invites). Target ≥ 80%
  during demo session.
- **Live agents during demo** — distinct `agentUri` with WS connection at
  any point. Target ≥ 8 (host's 7 + ≥1 invited participant).
- **Time from invite click → agent online**, p50. Target < 90s — that's
  what "live signup on stage" requires.

### Cost

- **Fly.io daily** — Fly's metrics dashboard. Alarm if anything non-zero
  appears on free tier.
- **Vercel daily build minutes** — Vercel project dashboard.
- **Anthropic API daily $** — `SELECT SUM(cost_usd) FROM llm_costs WHERE ts > now - 86400`.
  Per-user breakdown to spot a runaway participant.

### Performance

- **Coordinator p50/p95 RTT from public internet**. Measure via a Vercel
  cron that hits `/health` every minute and logs latency. Alarm at
  p95 > 500ms (probably means Fly app went cold).
- **Boot smoke duration** — log the total elapsed at boot. Trend over
  deploys; an upward drift means we're regressing the happy path.

### Failure signals

- **Boot smoke failure** — Fly health check fails, deploy rolls back.
  Page-able if it happens during demo (a phone notification will do).
- **WS reconnect storm** — coordinator already heartbeats. Add a counter:
  `ws.reconnect.user.<userId>` per minute. If > 5/min, log a warning.
- **Daily LLM cost > $5** — log a warning + post to a Slack-or-equivalent
  webhook if `LLM_BUDGET_WEBHOOK_URL` is set.
- **Admin login failures** — log every 401 on `/admin/*` with the source
  IP. Threshold 10 per hour = someone's brute-forcing; rotate the
  password.

### Instrumentation tasks (folded into the phases above)

- 1A: `wallets` table is itself the measurement substrate.
- 1F: `wallet.changed` events feed the dashboard panel and become the
  per-wallet timeline.
- 2D: `/admin/recent` is the "who joined" log.
- 3A: smoke step latencies logged structured.
- 5C: post-deploy smoke validates the meters work end-to-end.

---

## Dependency Graph

```
        ┌──────────── Phase 1 — Per-agent wallets ─────────────────┐
        │  1A schema/dao  •  1B creation hooks  •  1C escrow rewrite│
        │  1D fund flow   •  1E x402 wallet IDs  •  1F dashboard    │
        └────────────────────────────┬─────────────────────────────┘
                                     │ hard gate
        ┌──────────── Phase 2 — Public redeem + admin ─────────────┐
        │  2A /redeem  •  2B Add Agent wall  •  2C basic auth       │
        │  2D admin invite UI                                       │
        └────────────────────────────┬─────────────────────────────┘
                                     │ hard gate
        ┌──────────────── Phase 3 — Smoke-on-boot ─────────────────┐
        │  3A self-test runner   •   3B wire to startup            │
        └────────────────────────────┬─────────────────────────────┘
                                     │ hard gate
        ┌──────── Phase 4 — Starter template repo ─────────────────┐
        │  4A repo + vendoring  •  4B tag base  •  4C cross-link   │
        │  (CAN run in parallel with 1–3)                          │
        └────────────────────────────┬─────────────────────────────┘
                                     │ hard gate
        ┌──────────────────── Phase 5 — Deploy ────────────────────┐
        │  5A Fly coordinator  •  5B Vercel dashboard              │
        │  5C smoke vs deployed stack                              │
        └──────────────────────────────────────────────────────────┘
```

---

## Notes for Claude

- **The contracts file is still the constitution.** When you add
  `wallet.changed` or extend `X402ProofPayload`, update Zod schemas in
  `packages/contracts/src/index.ts` FIRST. Mocks drift = integration
  breaks.
- **Wallet IDs are stable strings, not bigint.** `wlt_<handle>_<slug>` for
  agent wallets, `wlt_user_<userId>` for user-default wallets. Don't
  introduce a numeric primary key just to feel professional — the human
  readability sells the demo.
- **Don't break v2 smoke.** `scripts/smoke-phase2.ts` should pass against
  the v3 coordinator unchanged. If a wallet rewrite forces a smoke
  update, write a new `smoke-phase3.ts` that covers wallet flow
  specifically and keep the v2 one as a regression net.
- **HTTP basic auth on `/admin` is a stopgap.** It's fine for the hackathon
  demo but obviously not real auth (no rate limit, no MFA, base64 over
  TLS). Note this in `docs/host-setup.md`. Replace with real auth
  post-hackathon.
- **`ADMIN_PASSWORD=password` is a literal default for local dev.** Fly +
  Vercel must override before the dashboard URL leaves your laptop.
  Include a `ADMIN_PASSWORD must not equal "password" when ADMIN_REQUIRE_STRONG=1`
  guard for production paranoia.
- **Vendoring beats publishing for the starter.** Don't fight with npm
  scope ownership or pnpm-publish two hours before demo. The starter repo
  is a frozen snapshot; participants can update against a future
  `v3.1-starter-base` tag.
- **Smoke-on-boot is permitted to write to `apps/coordinator/data/ac.db`.**
  It writes a `_boot_smoke_*` user + wallet + invite + completed contract.
  These rows persist; the dashboard's history panel sees one tiny
  "test" job on every boot. Acceptable noise; if a user wants it gone,
  cleanup runs at the end of the smoke.
- **Demo-day flow** (for reference, not implementation):
  1. Pre-issue 3 invites via `/admin`. Print the URLs as cards.
  2. Open dashboard on big screen.
  3. Talk about the architecture. Click "Add Agent" → show the wall.
  4. Hand a card to someone in the audience.
  5. They click the link on their phone, pick a handle, see the apiKey.
  6. You walk over with a laptop, paste the apiKey into the
     pre-cloned starter repo's `.env`, `npm start`. Their agent
     appears in the strip.
  7. Trigger a scenario. Their agent bids alongside the 7 host-owned
     ones. Their wallet balance goes up live.

---

## Parked — Awaiting explicit go

**Do not start any of these without the user typing "go on <item>".** They
are listed here so the doc captures the full v3 vision, not so they get
silently implemented.

1. **Reputation-weighted bid selection.** Posters can set `minReputation`
   on `POST /jobs`. Bids below the floor are filtered. Sells the "trust
   has consequence" story.

2. **Tipping.** Poster can credit the bidder extra on deliver. Generates
   positive-delta receipts the ticker renders green.

3. **Hostile-participant pre-staged scenario.** One invite for "demo
   villain", a thin agent that bids lowest then never delivers. Run live
   on stage; watch the sweeper refund + reputation tank to zero. Best
   single demo moment we haven't built.

4. **Receipt graph.** Force-directed SVG of wallet-to-wallet payments in
   the last 5 minutes. Shows the marketplace as a network. Pairs with
   per-agent wallets.

5. **Public leaderboard.** Top 5 agents by 24h earnings, pinned to
   dashboard header.

6. **"Bad agent" siren.** Big red banner when `contract.timed_out` rate
   exceeds threshold in any rolling 5-minute window.

7. **Real keypair signing for agent identity.** Replace the ornamental
   `pubkey` with real ed25519 keys. Agent signs delivery; coordinator
   verifies. Sells "agents are first-class entities".

8. **Per-agent (not just per-user) daily token cap.** Protects a user
   from one of their agents going rogue and burning their own cap.

9. **Brief content moderation.** Cheap Claude pass on `POST /jobs` to
   reject NSFW / scam briefs. Probably invisible on stage; worth it for
   "what if randos signed up" liability.

10. **`/admin/reset` endpoint.** Host-only. Nukes ephemeral marketplace
    state without coordinator restart. 1-second recovery if a scenario
    gets stuck.

11. **Curated demo-loop scenario.** A pre-staged script that fires a
    job → bids → wars → settles every 30s in the background so the
    dashboard is never idle while presenting.

12. **Mock chain-explorer page.** `/wallets/<id>` route on the dashboard
    showing transaction history per wallet. Pure stagecraft, very
    on-thesis. Pairs with per-agent wallets + receipt graph.

13. **Web QR code generation in the admin UI.** `/admin` invite cards
    render with a QR code so audience members can scan on phones.
    Replaces "card printing" with "phone screen".

---

## What's deliberately out of scope (even from Parked)

- **No real cryptography for x402.** HMAC stays the auth model. A real
  chain integration is post-hackathon.
- **No multi-host federation.** One coordinator, one host. If a second
  host wants to join, they spin up their own deployment.
- **No persistent jobs/bids.** Same as v2 — only outcome state survives.
- **No agent SDK in any language other than TypeScript.**
- **No participant billing.** Mock wallets only. No fiat, no chain, no
  invoice. The marketplace exists to *prove* x402 — not to operate it.
- **No GitHub OAuth on admin.** Basic auth is the demo answer; the real
  answer is rebuilding auth from scratch with a session model, and that's
  not three hours of work.
