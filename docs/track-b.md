# Track B — Dashboard (shipped)

Status: **complete**, typecheck clean, dev server boots in ~1s and serves
on `:3000`. Live-WS and REST hydration both wired.

## Layout

Three panes, dark mode default:

```
┌──────────────────────────────────────────────────────────────┐
│  Header — logo, jobs counter, projector toggle, conn dot     │
├──────────┬─────────────────────────────────┬─────────────────┤
│ Agents   │  Event ticker (live, pausable)  │  Metric panels  │
│ + rep    │                                 │  + top earners  │
│ + spend  │  newest at top, auto-scroll     │                 │
└──────────┴─────────────────────────────────┴─────────────────┘
              floating page preview (Coframe iframe)
```

## What's in place

### `app/page.tsx`
Single-page client component. Wires `useDashboard()` and lays out the four
display components. No SSR (everything is live).

### `lib/state.ts` — `useDashboard()`
The state hook. Does:
- **WS reconnect with exponential backoff** (250ms → 5s cap). Sets
  `connected: true/false` for the header dot.
- **On (re)connect, hydrates from REST**: `/registry/agents`,
  `/spend/total`, `/spend/per-agent`. WS doesn't replay history; REST is
  the source of truth on reconnect.
- **Ring buffer of last 200 events** for the ticker.
- **Derived state**: `agents`, `llmSpend`, `lastSeen` (for the flash
  animation), `metrics` from `metrics.tick`, `preview` from `job.completed`
  events whose `result.url` exists.

### `lib/format.ts`
Tiny formatters: `usd`, `ms` (1234ms → "1.2s"), `pct`, `shortTime`,
`shortUri`. Keeps display code lean.

### `components/Header.tsx`
- Connection indicator (live pulse / red when offline)
- `jobs since boot` counter
- **Projector toggle** — adds a `projector` class on `<html>` that bumps base
  `font-size` to 22px. Defined in `globals.css`.

### `components/AgentStrip.tsx` (left, 260px)
- One row per registered agent (filters out `__poster__` shells).
- Reputation bar (gradient fuchsia→cyan, width = `reputation × 100%`).
- Capability chips, earned USD, LLM spend.
- **Flash animation** on `lastSeen` update (CSS `@keyframes flash`,
  1.4s). Triggered by `bid.placed`, `contract.signed`, `agent.registered`,
  `llm.cost`.

### `components/Ticker.tsx` (center, flexible)
- Newest events at top, auto-scrolls to keep top in view.
- **Pause toggle**: when paused, incoming events still queue but auto-scroll
  freezes; a "+N buffered" indicator appears.
- Per-event-type accent colors (from `tailwind.config.ts → theme.colors.evt`).
- Custom `describe()` renderer per event type — agent URIs are shortened,
  USD formatted, briefs truncated to 60 chars.
- Skips `heartbeat` and (currently) renders `metrics.tick` only on demand —
  the metric panel is the more useful surface for that.

### `components/MetricPanels.tsx` (right, 320px)
- Big total-spend card up top.
- LLM spend with receipts subtitle.
- 2×2 grid: p50 negotiation, p95 negotiation, active jobs, success rate
  (color-coded: green ≥95%, yellow ≥80%, red below).
- Top 5 earners list, sorted by `earnedUsd`.

### `components/PagePreview.tsx`
- Floating bottom-right iframe (420×480px) when `state.preview` is set.
- Sandboxed (`allow-scripts` only), reloads when a new preview arrives.
- **Open in new tab** link + close (reopenable). The Coframe slice's
  payoff lands here.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_COORD_URL` | `http://localhost:8787` | REST base |
| `NEXT_PUBLIC_COORD_WS` | `ws://localhost:8787/ws` | WS subscribe URL |

## CORS

Coordinator now registers `@fastify/cors` with `origin: true` (permissive,
demo-grade). Required so the browser at `:3000` can fetch REST and so the
iframe can pull the rendered page from `:9105`.

## How to run

```bash
# Terminal 1 — coordinator (no change)
pnpm coordinator

# Terminal 2 — all agents
pnpm demo

# Terminal 3 — dashboard
pnpm dashboard      # opens at http://localhost:3000

# Terminal 4 — drive a scenario, watch the dashboard react
pnpm scenario:page  # the iframe will fill with the rendered page
```

## Smoke results at ship time

| Check | Result |
|---|---|
| `pnpm -r typecheck` | clean across 7 packages |
| `pnpm dashboard` boot | ready in ~1s |
| `GET /` initial render | HTTP 200, 15.7KB |

## Known follow-ups (Phase 3 polish)

- **"Replay last 30s" button** (1B.6) — not yet implemented. We'd need to
  buffer event timestamps on the client (already have ring buffer) and
  re-emit them on a timer. Easy add-on.
- **`metrics.tick` event in ticker** is currently skipped via `describe()`
  fallthrough — show on demand toggle.
- **Negotiation message visualizer** — `negotiation.message` events render
  as a single row; for scenario 3 (bidding war) we may want a dedicated
  pane showing back-and-forth at a glance.
- **Reputation deltas as floating `+0.05`** (3D) — `job.completed` carries
  enough info; spawn an absolutely-positioned animated chip near the
  agent row. Phase 3.
