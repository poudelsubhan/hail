"use client";

import { useEffect, useState } from "react";

interface Capability {
  tag: string;
  agentCount: number;
  agents: string[];
  jobsLast24h: number;
  lastJobTs: number;
  sampleBriefs: string[];
}

interface Snapshot {
  capabilities: Capability[];
  ts: number;
}

const POLL_MS = 5_000;
const COORD_URL =
  process.env.NEXT_PUBLIC_COORDINATOR_URL ?? "http://localhost:8787";

/**
 * Bubble cloud of marketplace capabilities. Size = jobs in last 24h; opacity
 * leans on agentCount so well-served tags pop. Helps newcomers see what's hot.
 */
export function CapabilityCloud() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const res = await fetch(`${COORD_URL}/capabilities`);
        if (res.ok) {
          const j = (await res.json()) as Snapshot;
          if (!stop) setData(j);
        }
      } catch {/* ignore — next tick retries */}
    }
    void tick();
    const h = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(h); };
  }, []);

  if (!data || data.capabilities.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3">
        <h3 className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
          Capabilities
        </h3>
        <div className="text-xs text-neutral-500">
          {data ? "no capabilities posted yet" : "loading…"}
        </div>
      </div>
    );
  }

  const maxJobs = Math.max(1, ...data.capabilities.map((c) => c.jobsLast24h));
  const focus = data.capabilities.find((c) => c.tag === focused);

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3">
      <h3 className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
        Capabilities · 24h
      </h3>
      <div className="flex flex-wrap gap-2">
        {data.capabilities.map((c) => {
          const sizeBucket =
            c.jobsLast24h === 0
              ? "text-[10px]"
              : c.jobsLast24h / maxJobs > 0.66
                ? "text-base"
                : c.jobsLast24h / maxJobs > 0.33
                  ? "text-sm"
                  : "text-xs";
          const colorClass =
            c.agentCount === 0
              ? "text-rose-300 border-rose-500/40"
              : c.agentCount === 1
                ? "text-yellow-300 border-yellow-500/40"
                : "text-emerald-300 border-emerald-500/40";
          return (
            <button
              key={c.tag}
              onClick={() => setFocused(focused === c.tag ? null : c.tag)}
              className={`px-2 py-1 rounded border bg-neutral-900 hover:bg-neutral-800 ${sizeBucket} ${colorClass} ${focused === c.tag ? "ring-1 ring-cyan-300" : ""}`}
              title={`${c.agentCount} agent(s), ${c.jobsLast24h} jobs / 24h`}
            >
              {c.tag}
              <span className="ml-1 text-neutral-500 text-[10px]">
                {c.agentCount}·{c.jobsLast24h}
              </span>
            </button>
          );
        })}
      </div>
      {focus && (
        <div className="mt-3 border-t border-neutral-800 pt-2 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            {focus.tag} · {focus.agentCount} agent{focus.agentCount === 1 ? "" : "s"} · {focus.jobsLast24h} jobs
          </div>
          {focus.agents.slice(0, 4).map((a) => (
            <div key={a} className="text-xs text-neutral-300 truncate">
              {a.replace(/^agent:\/\//, "")}
            </div>
          ))}
          {focus.sampleBriefs.length > 0 && (
            <ul className="text-[11px] text-neutral-500 list-disc pl-4 mt-1 space-y-0.5">
              {focus.sampleBriefs.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
