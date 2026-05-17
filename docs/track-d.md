# Track D — x402 mock (hardened) + spend rollups (shipped)

Status: **complete**, 10/10 unit tests pass + full e2e green.

## What changed from Track A

Track A had `apps/coordinator/src/x402.ts` as an inline mock. Track D
extracted it into `packages/x402` (its own workspace package) and hardened it
with replay/TTL protection. Coordinator call sites now hit `x402.issueChallenge` /
`x402.settle` / `x402.verifyPaymentProof` on a singleton instance from
`apps/coordinator/src/x402-instance.ts`.

This keeps the wire shape identical (so contracts and existing tests didn't
need to change) while making the payment layer something you can reason about
in isolation.

### Deviation from the plan

`plan.md` says `verifyPaymentProof` is exported from `packages/contracts`. I
put it in `packages/x402` instead. Reason: `packages/contracts` is the
schema-only constitution — adding runtime crypto logic there would muddy what
that package is for. `packages/x402` re-exports the right types from
`@ac/contracts` and owns the implementation. Caller-facing API is the same.

## Hardening over the Track A mock

| Issue                              | Track A | Track D                       |
|------------------------------------|---------|-------------------------------|
| Nonce expiry                       | none    | 5 min TTL (configurable)      |
| Settle replay (same nonce twice)   | implicit (deleted) | explicit `unknown_nonce` after consume |
| Stale nonce error reason           | `unknown_nonce` | `expired_nonce` (more useful) |
| Deliver replay (same proof twice)  | not detected | `replayed_proof` returned |
| Bad-signature detection            | constant-time | constant-time (unchanged) |
| Unit tests                         | none    | 10 (`pnpm --filter @ac/x402 test`) |
| Clock injectable for tests         | no      | `now: () => number` config option |

## Package surface

```ts
import { X402 } from "@ac/x402";

const x = new X402({
  secret: process.env.X402_HMAC_SECRET,
  nonceTtlMs: 5 * 60_000, // default
});

const ch = x.issueChallenge({
  contractId, amountUsd, posterUri, bidderUri,
});                       // → { nonce, amountUsd, settleUrl }

const r = x.settle({ nonce, amountUsd, from: posterUri });
// → { ok: true, paymentProof, contractId, amountUsd }
// |  { ok: false, reason: "unknown_nonce" | "expired_nonce" | "amount_mismatch" | "wrong_payer" }

const v = x.verifyPaymentProof(proof, expectedContractId);
// → { ok: true, payload: ProofPayload }
// |  { ok: false, reason: "malformed_proof" | "bad_signature" | "malformed_payload" | "contract_mismatch" | "replayed_proof" }
```

## New REST endpoints — spend rollups for the dashboard

These complement the live WS stream. WS gives you incremental updates;
these endpoints are the source of truth on reconnect (since we don't replay
events).

| Endpoint                   | Returns |
|----------------------------|---------|
| `GET /spend/total`         | `{ totalSpendUsd, llmSpendUsd, receipts, ts }` |
| `GET /spend/per-agent`     | `{ agents: [{ agentUri, earnedUsd, llmSpendUsd, reputation }] }` sorted by earnings desc |
| `GET /spend/per-capability`| `{ capabilities: [{ capability, spendUsd }] }` sorted by spend desc |

`llmSpendUsd` is fed by the `setClaudeLogSink` hook in the coordinator's
`index.ts` — every Claude call anywhere in the repo aggregates into these
totals automatically.

## Receipts surface (unchanged from Track A)

| Endpoint                   | Returns |
|----------------------------|---------|
| `GET /receipts?since=<ts>` | `{ receipts: Receipt[] }` filtered by `ts >= since` |

Use for dashboard backfill on reconnect.

## Smoke results at ship time

| Test                          | Result                         |
|-------------------------------|--------------------------------|
| 10 unit tests in `@ac/x402`   | 10/10 pass, total ~94ms        |
| `pnpm -r typecheck`           | clean across 5 packages        |
| `scripts/smoke-e2e.ts`        | unchanged — 7 lifecycle events |
| `/spend/total`                | `$0.04 / $0 LLM / 1 receipt`   |
| `/spend/per-agent`            | bidder $0.04, rep 0.55         |
| `/spend/per-capability`       | summarize: $0.04               |

## Env vars

| Var                  | Purpose                                      |
|----------------------|----------------------------------------------|
| `X402_HMAC_SECRET`   | HMAC key for proofs. Stable across runs important if you ever want a proof issued in one boot to verify in another, but state dies with process so it doesn't strictly matter. Coordinator prints a warning when the dev default is in use. |

## What the dashboard (Track B) gets from D

- **Headline panel inputs**: `/spend/total` for the top-line dollar number
- **Per-agent leaderboard**: `/spend/per-agent` — sortable by `earnedUsd` or `reputation`
- **Per-capability bar chart**: `/spend/per-capability`
- **Live `payment.settled` and `llm.cost` WS events** for incremental updates

## What's still mocked

This is **shape-only x402**, no chain, no real money. Demo claim should be
"the wire is x402-shaped: HTTP 402 + nonce + signed proof." If a judge asks
"is this on a real chain?" the answer is "no, but everything above the chain
is identical and would swap one component to be live."
