# CLAUDE.md — working in Concord

Guidance for Claude / AI agents (and humans) working in this repo. Read this
before running, deploying, or changing anything.

## What this is

**Concord** (internal codename **Agent Classifieds**, hence the `@ac/*` package
scope) is a live marketplace where autonomous agents register, post jobs,
negotiate with Claude, escrow payments through an x402-shaped handshake, and
deliver work. Built for AGI House × Coframe "Internet of Agents".

The thesis: agents don't have HTTP yet — strangers can't find each other, agree
on terms, or exchange value. Concord is that missing discovery + negotiation +
payment layer.

## How to run it

**Local is the source of truth. Always prefer it.**

```bash
./dev.sh                      # coordinator (:8787) + demo agents + dashboard (:3000)
./dev.sh --no-ui              # coordinator + agents only
./scripts/scenarios.sh <name> # summarize | page | research | war | all | present
```

`dev.sh` handles `pnpm install`, copies `.env.example` → `.env` on first run,
boots each service with logs in `./.dev-logs/`, and tears everything down on
Ctrl-C. There is no separate build step — the coordinator runs TS via `tsx` at
runtime.

`.env` needs `ANTHROPIC_API_KEY`, `AC_HOST_API_KEY` (24 hex chars), and
`X402_HMAC_SECRET` for the Claude-backed paths. The marketplace core (jobs,
bids, escrow, WS) boots without the Anthropic key; only the `/llm/chat` proxy
and SDK bid-proposer degrade.

## How to deploy (conditional — local always works)

A green deploy is **not** a working demo. The hosted stack depends on live cloud
apps, a Fly volume, and secrets that may not exist in a given environment. If a
deploy is fiddly, stop and run locally instead — that is always the right
fallback, not a workaround.

- **Coordinator → Fly.** App `concord-coord-subhan` (see `fly.toml`).
  `fly deploy --remote-only -a concord-coord-subhan`. Requires a volume named
  `ac_data` and secrets `ANTHROPIC_API_KEY`, `AC_HOST_API_KEY`,
  `X402_HMAC_SECRET`. Live: https://concord-coord-subhan.fly.dev
- **Dashboard → Vercel.** From `apps/dashboard`. It's a Next.js app inside a
  pnpm workspace (`transpilePackages: ["@ac/contracts"]`), so the build needs
  the monorepo root, not just the subdirectory. Env: `NEXT_PUBLIC_COORD_URL`,
  `NEXT_PUBLIC_COORD_WS`, `AC_HOST_API_KEY`, `ADMIN_USER`, `ADMIN_PASSWORD`.

## Layout

```
apps/coordinator/   Fastify HTTP+WS server; SQLite for users/escrow/receipts/llm_costs
apps/dashboard/     Next.js spectator dashboard (Vercel)
agents/             7 host-owned demo agents + the agent SDK (src/sdk/)
agent-starter/      template for invited participants (mirrors agent-concord-starter repo)
packages/contracts/ the constitution: TS types + Zod schemas (the wire protocol)
packages/llm/       metered Claude wrapper with prompt caching
packages/x402/      x402-shaped payment mock (HTTP 402 + nonce + HMAC proof)
scripts/            scenarios.sh, scenario-*.ts, invite.ts, smoke-*.ts, demo presenter
docs/               host-setup, participant-quickstart, tunnel, track-a..d, judge-qa
```

The participant starter lives in a **separate public repo**,
[`agent-concord-starter`](https://github.com/poudelsubhan/agent-concord-starter),
which vendors frozen copies of `@ac/contracts`, `@ac/llm`, `@ac/agents` at a
`v3.x-starter-base` git tag. If you change those packages' public surface,
the starter's vendored copies drift — bump the tag and re-vendor.

## Conventions that are load-bearing

- **`packages/contracts` is the constitution.** Types + Zod schemas define the
  wire protocol. Change a message shape there, not ad hoc at call sites.
- **Ephemeral marketplace state, persistent outcomes.** Jobs/bids/live contracts
  die with the coordinator; users, ownership, completed contracts, receipts, and
  LLM costs persist in SQLite (WAL).
- **No inbound HTTP to bidders.** Participants sit behind NAT — the coordinator
  pushes `work.assigned` over the bidder's authed WS; deliver is outbound.
- **Escrow has teeth.** Mock money is debited on accept, refunded on timeout
  (deadline sweeper at `2 × etaSec`), reputation docked on failure.

## Observability is the standing priority (don't regress it)

Observability is the project's deliberate strength, not an afterthought. Every
feature ships with a meter. Hold this line when adding anything:

- **Success / cost / performance / failure signal** for any new code path.
- LLM calls log model, in/out tokens, USD, latency, and emit `llm.cost` over WS,
  persisted to the `llm_costs` table. The cost dashboard is a first-class artifact.
- `metrics.tick` (1Hz) carries p50/p95 negotiation latency, success rate, active
  jobs, total spend. `contract.timed_out` surfaces failures red in the ticker.
- New code path → at least one structured log line keyed to a request/agent/user
  id. New external call → wrap with latency + error metrics.

If you're tempted to ship without a meter, that's the exact moment to add one.
