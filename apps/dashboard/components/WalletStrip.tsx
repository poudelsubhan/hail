"use client";

import { useEffect, useState } from "react";
import type { DashboardState } from "../lib/state";
import { usd } from "../lib/format";

const RECENT_MS = 1400;

function shortWallet(id: string, agentUri: string | null): string {
  if (agentUri) {
    // wlt_<handle>_<slug> → handle.slug for the demo
    const m = /^wlt_([^_]+)_(.+)$/.exec(id);
    if (m) return `${m[1]}.${m[2]}`;
    return id;
  }
  // user-default wallet — drop the wlt_user_ prefix
  return id.replace(/^wlt_user_/, "user:");
}

export function WalletStrip({ state }: { state: DashboardState }) {
  const wallets = Object.values(state.wallets)
    .sort((a, b) => b.balanceUsd - a.balanceUsd)
    .slice(0, 8);

  return (
    <section className="border-t border-neutral-800">
      <h2 className="text-xs uppercase tracking-wider text-neutral-500 px-3 pt-3 pb-1">
        Wallets · {Object.keys(state.wallets).length}
      </h2>
      <ul className="divide-y divide-neutral-900">
        {wallets.map((w) => (
          <WalletRow
            key={w.id}
            id={w.id}
            label={shortWallet(w.id, w.agentUri)}
            balanceUsd={w.balanceUsd}
            agent={!!w.agentUri}
            lastDeltaUsd={w.lastDeltaUsd}
            lastChangedTs={w.lastChangedTs}
          />
        ))}
        {wallets.length === 0 && (
          <li className="px-3 py-3 text-xs text-neutral-500">no wallets yet</li>
        )}
      </ul>
    </section>
  );
}

function WalletRow({
  id,
  label,
  balanceUsd,
  agent,
  lastDeltaUsd,
  lastChangedTs,
}: {
  id: string;
  label: string;
  balanceUsd: number;
  agent: boolean;
  lastDeltaUsd?: number;
  lastChangedTs?: number;
}) {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!lastChangedTs) return;
    if (Date.now() - lastChangedTs > RECENT_MS) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), RECENT_MS);
    return () => clearTimeout(t);
  }, [lastChangedTs]);

  const recentDelta =
    lastDeltaUsd != null && lastChangedTs && Date.now() - lastChangedTs < 2000
      ? lastDeltaUsd
      : null;

  return (
    <li
      className={`relative px-3 py-2 text-xs flex items-center justify-between ${
        flash ? "flash" : ""
      }`}
      title={id}
    >
      <span className={agent ? "text-neutral-300" : "text-neutral-500"}>{label}</span>
      <span className="flex items-baseline gap-2">
        {recentDelta != null && (
          <span
            className={`rep-rise text-[10px] font-semibold ${
              recentDelta >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
            key={lastChangedTs}
          >
            {recentDelta >= 0 ? "+" : ""}
            {usd(recentDelta, 2).replace("$", "")}
          </span>
        )}
        <span className="text-neutral-200 font-mono">{usd(balanceUsd, 2)}</span>
      </span>
    </li>
  );
}
