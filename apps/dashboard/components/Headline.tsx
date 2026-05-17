"use client";

import type { DashboardState } from "../lib/state";
import { ms, pct, usd } from "../lib/format";

/**
 * Since-boot headline strip — the row of big numbers we point at in the
 * demo. Lives between header and the three-pane grid.
 */
export function Headline({ state }: { state: DashboardState }) {
  const m = state.metrics;
  const agentsOnline = Object.values(state.agents).filter(
    (a) => !a.capabilities.includes("__poster__"),
  ).length;

  return (
    <div className="flex items-stretch gap-4 px-6 py-3 border-b border-neutral-800 bg-neutral-950">
      <HeadCell label="jobs done" value={String(state.jobsCompleted)} />
      <HeadCell label="total spend" value={usd(m.totalSpendUsd, 2)} accent="text-cyan-300" />
      <HeadCell label="llm spend" value={usd(state.llmSpendTotal, 4)} accent="text-evt-llm" />
      <HeadCell label="p50 nego" value={ms(m.p50ms)} />
      <HeadCell label="p95 nego" value={ms(m.p95ms)} />
      <HeadCell
        label="success"
        value={pct(m.successRate)}
        accent={
          m.successRate >= 0.95
            ? "text-emerald-400"
            : m.successRate >= 0.8
              ? "text-yellow-400"
              : "text-rose-400"
        }
      />
      <HeadCell label="agents online" value={String(agentsOnline)} />
    </div>
  );
}

function HeadCell({
  label,
  value,
  accent = "text-neutral-100",
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className={`text-xl font-semibold ${accent}`}>{value}</div>
    </div>
  );
}
