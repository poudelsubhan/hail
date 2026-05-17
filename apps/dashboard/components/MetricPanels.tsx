"use client";

import type { DashboardState } from "../lib/state";
import { ms, pct, usd } from "../lib/format";
import { CapabilityCloud } from "./CapabilityCloud";
import { WalletStrip } from "./WalletStrip";

export function MetricPanels({ state }: { state: DashboardState }) {
  const m = state.metrics;
  const successColor =
    m.successRate >= 0.95
      ? "text-emerald-400"
      : m.successRate >= 0.8
        ? "text-yellow-400"
        : "text-rose-400";

  return (
    <aside className="border-l border-neutral-800 overflow-y-auto p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-wider text-neutral-500">
        Live metrics
      </h2>

      <Card label="Total spend (USD)" value={usd(m.totalSpendUsd, 3)} accent="text-cyan-300" big />
      <Card
        label="LLM spend"
        value={usd(state.llmSpendTotal, 5)}
        accent="text-evt-llm"
        sub={`${state.receiptsCount} receipts`}
      />
      <div className="grid grid-cols-2 gap-3">
        <Card label="p50 nego" value={ms(m.p50ms)} sub="post→signed" />
        <Card label="p95 nego" value={ms(m.p95ms)} sub="post→signed" />
        <Card label="Active jobs" value={String(m.activeJobs)} />
        <Card label="Success" value={pct(m.successRate)} accent={successColor} />
      </div>

      <CapabilityCloud />

      <WalletStrip state={state} />

      <div>
        <h3 className="text-[10px] uppercase tracking-wider text-neutral-500 mt-4 mb-2">
          Top earners
        </h3>
        <ul className="space-y-1">
          {Object.values(state.agents)
            .filter((a) => !a.capabilities.includes("__poster__"))
            .sort((a, b) => (b.earnedUsd ?? 0) - (a.earnedUsd ?? 0))
            .slice(0, 5)
            .map((a) => (
              <li key={a.uri} className="flex justify-between text-xs">
                <span className="text-neutral-300 truncate">
                  {a.uri.replace(/^agent:\/\//, "").replace(/\.local$/, "")}
                </span>
                <span className="text-cyan-300">{usd(a.earnedUsd ?? 0, 3)}</span>
              </li>
            ))}
        </ul>
      </div>
    </aside>
  );
}

function Card({
  label,
  value,
  sub,
  accent = "text-neutral-100",
  big = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  big?: boolean;
}) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className={`${big ? "text-2xl" : "text-lg"} font-semibold mt-1 ${accent}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-neutral-500 mt-0.5">{sub}</div>}
    </div>
  );
}
