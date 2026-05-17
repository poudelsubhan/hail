"use client";

import { useEffect, useState } from "react";
import type { DashboardState } from "../lib/state";
import { shortUri, usd } from "../lib/format";

function pickDelta(repDeltas: DashboardState["repDeltas"], uri: string) {
  // newest delta for this agent — useful when several land in quick succession
  for (let i = repDeltas.length - 1; i >= 0; i--) {
    if (repDeltas[i]!.agentUri === uri) return repDeltas[i]!;
  }
  return null;
}

const RECENT_MS = 1400; // flash window matching CSS animation duration

export function AgentStrip({ state }: { state: DashboardState }) {
  const agents = Object.values(state.agents)
    .filter((a) => !a.capabilities.includes("__poster__"))
    .sort((a, b) => (b.reputation ?? 0) - (a.reputation ?? 0));

  return (
    <aside className="border-r border-neutral-800 overflow-y-auto">
      <h2 className="text-xs uppercase tracking-wider text-neutral-500 px-4 pt-4 pb-2">
        Agents · {agents.length}
      </h2>
      <ul className="divide-y divide-neutral-900">
        {agents.map((a) => (
          <AgentRow
            key={a.uri}
            uri={a.uri}
            capabilities={a.capabilities}
            reputation={a.reputation ?? 0.5}
            earnedUsd={a.earnedUsd ?? 0}
            llmSpend={state.llmSpend[a.uri] ?? 0}
            lastSeen={state.lastSeen[a.uri]}
            repDelta={pickDelta(state.repDeltas, a.uri)}
          />
        ))}
        {agents.length === 0 && (
          <li className="px-4 py-6 text-sm text-neutral-500">
            no agents yet — run <code className="text-neutral-300">pnpm demo</code>
          </li>
        )}
      </ul>
    </aside>
  );
}

function AgentRow({
  uri,
  capabilities,
  reputation,
  earnedUsd,
  llmSpend,
  lastSeen,
  repDelta,
}: {
  uri: string;
  capabilities: string[];
  reputation: number;
  earnedUsd: number;
  llmSpend: number;
  lastSeen?: number;
  repDelta: { id: string; delta: number; ts: number } | null;
}) {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!lastSeen) return;
    if (Date.now() - lastSeen > RECENT_MS) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), RECENT_MS);
    return () => clearTimeout(t);
  }, [lastSeen]);

  const repBar = Math.round(reputation * 100);
  const recentDelta = repDelta && Date.now() - repDelta.ts < 2000 ? repDelta : null;
  return (
    <li className={`relative px-4 py-3 ${flash ? "flash" : ""}`}>
      {recentDelta && (
        <span
          key={recentDelta.id}
          className={`rep-rise absolute right-2 top-2 text-sm font-semibold ${
            recentDelta.delta >= 0 ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {recentDelta.delta >= 0 ? "+" : ""}
          {recentDelta.delta.toFixed(2)}
        </span>
      )}
      <div className="flex items-baseline justify-between">
        <div className="text-sm text-neutral-200">{shortUri(uri)}</div>
        <div className="text-[10px] text-neutral-500">{(reputation).toFixed(2)}</div>
      </div>
      <div className="flex flex-wrap gap-1 mt-1">
        {capabilities.map((c) => (
          <span
            key={c}
            className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300"
          >
            {c}
          </span>
        ))}
      </div>
      <div className="h-1 mt-2 rounded-full bg-neutral-900 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-fuchsia-500 to-cyan-400"
          style={{ width: `${repBar}%` }}
        />
      </div>
      <div className="flex justify-between mt-2 text-[10px] text-neutral-500">
        <span>earned {usd(earnedUsd, 3)}</span>
        <span>llm {usd(llmSpend, 5)}</span>
      </div>
    </li>
  );
}
