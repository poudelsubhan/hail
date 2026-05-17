import { store } from "./store.js";
import { bus } from "./bus.js";

/**
 * Rolling-window metrics + 1Hz broadcast. Window: 60s. Plan target:
 * post → contract.signed under 5s p50 to feel alive.
 */

const WINDOW_MS = 60_000;

// Latency samples: post → contract.signed (the negotiation half)
const negotiationSamples: { ts: number; ms: number }[] = [];
// Outcome samples for success rate
const outcomeSamples: { ts: number; success: boolean }[] = [];

export function recordNegotiationLatency(jobId: string) {
  const posted = store.jobPostedAt.get(jobId);
  const signed = store.jobContractedAt.get(jobId);
  if (posted == null || signed == null) return;
  negotiationSamples.push({ ts: Date.now(), ms: signed - posted });
}

export function recordOutcome(jobId: string, success: boolean) {
  outcomeSamples.push({ ts: Date.now(), success });
}

function pruneOld<T extends { ts: number }>(arr: T[]) {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length > 0 && arr[0]!.ts < cutoff) arr.shift();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx]!;
}

export function snapshotMetrics() {
  pruneOld(negotiationSamples);
  pruneOld(outcomeSamples);

  const ms = negotiationSamples.map((s) => s.ms).sort((a, b) => a - b);
  const p50ms = percentile(ms, 50);
  const p95ms = percentile(ms, 95);

  const successes = outcomeSamples.filter((s) => s.success).length;
  const successRate =
    outcomeSamples.length === 0 ? 1 : successes / outcomeSamples.length;

  let activeJobs = 0;
  for (const j of store.jobs.values()) {
    if (j.state !== "settled" && j.state !== "failed") activeJobs++;
  }

  return {
    activeJobs,
    totalSpendUsd: store.totalSpendUsd,
    p50ms,
    p95ms,
    successRate,
  };
}

export function startMetricsTick() {
  setInterval(() => {
    const snap = snapshotMetrics();
    bus.publish({
      type: "metrics.tick",
      ...snap,
      ts: Date.now(),
    });
  }, 1000);
}
