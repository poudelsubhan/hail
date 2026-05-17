"use client";

import { useEffect, useRef, useState } from "react";
import type { WsEvent } from "@ac/contracts";
import { shortTime, shortUri, usd } from "../lib/format";

const ACCENT: Record<string, string> = {
  "agent.registered": "text-evt-register border-evt-register",
  "job.posted": "text-evt-posted border-evt-posted",
  "bid.placed": "text-evt-bid border-evt-bid",
  "contract.signed": "text-evt-contract border-evt-contract",
  "payment.settled": "text-evt-payment border-evt-payment",
  "job.completed": "text-evt-completed border-evt-completed",
  "llm.cost": "text-evt-llm border-evt-llm",
  "metrics.tick": "text-evt-metric border-evt-metric",
  "negotiation.message": "text-violet-300 border-violet-300",
  "work.assigned": "text-evt-assigned border-evt-assigned",
  "contract.timed_out": "text-evt-timeout border-evt-timeout",
};

export function Ticker({ events }: { events: WsEvent[] }) {
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [shownCount, setShownCount] = useState(events.length);

  // Auto-scroll to top when new events arrive (newest at index 0).
  useEffect(() => {
    if (paused) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setShownCount(events.length);
  }, [events, paused]);

  const pendingCount = paused ? events.length - shownCount : 0;

  return (
    <section className="flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">
          Event ticker · {events.length}
        </h2>
        <div className="flex items-center gap-2 text-[10px]">
          {pendingCount > 0 && (
            <span className="text-cyan-300">+{pendingCount} buffered</span>
          )}
          <button
            onClick={() => setPaused((v) => !v)}
            className={`px-2 py-1 rounded border ${
              paused
                ? "border-yellow-400 text-yellow-300"
                : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {paused ? "paused" : "live"}
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 pb-4 space-y-1.5"
      >
        {events.length === 0 && (
          <div className="text-sm text-neutral-500 mt-12 text-center">
            waiting for events…
          </div>
        )}
        {events.map((e, i) => (
          <Row key={`${e.ts}-${i}`} evt={e} />
        ))}
      </div>
    </section>
  );
}

function Row({ evt }: { evt: WsEvent }) {
  if (evt.type === "heartbeat") return null;
  const accent = ACCENT[evt.type] ?? "text-neutral-400 border-neutral-700";

  return (
    <div className="flex items-start gap-3 text-xs leading-tight flash">
      <span className="text-neutral-600 font-mono shrink-0 w-20 mt-0.5">
        {shortTime(evt.ts)}
      </span>
      <span
        className={`shrink-0 w-32 text-[10px] uppercase tracking-wider border-l-2 pl-2 ${accent}`}
      >
        {evt.type}
      </span>
      <span className="text-neutral-200">{describe(evt)}</span>
    </div>
  );
}

function describe(e: WsEvent): React.ReactNode {
  switch (e.type) {
    case "agent.registered":
      return (
        <>
          {shortUri(e.uri)}{" "}
          <span className="text-neutral-500">[{e.capabilities.join(",")}]</span>
        </>
      );
    case "job.posted":
      return (
        <>
          {shortUri(e.posterUri)} → {e.capability} · max {usd(e.maxPriceUsd, 3)} ·{" "}
          <span className="text-neutral-500">{truncate(e.brief, 60)}</span>
        </>
      );
    case "bid.placed":
      return (
        <>
          {shortUri(e.bidderUri)} bid {usd(e.priceUsd, 3)} ({e.etaSec}s)
          {e.note && <span className="text-neutral-500"> · {truncate(e.note, 50)}</span>}
        </>
      );
    case "contract.signed":
      return (
        <>
          {shortUri(e.parties[0])} → {shortUri(e.parties[1])} ·{" "}
          {usd(e.priceUsd, 3)}
        </>
      );
    case "payment.settled":
      return (
        <>
          {e.contractId.slice(0, 12)}… settled {usd(e.priceUsd, 3)}
        </>
      );
    case "job.completed":
      return (
        <>
          {e.jobId.slice(0, 12)}… {e.success ? "✓" : "✗"} in {Math.round(e.latencyMs)}ms
        </>
      );
    case "llm.cost":
      return (
        <>
          {e.agentUri ? shortUri(e.agentUri) : "?"} · {e.model} · {e.inputTokens}in/
          {e.outputTokens}out · {usd(e.costUsd, 5)} · {e.latencyMs}ms
        </>
      );
    case "metrics.tick":
      return (
        <>
          spend {usd(e.totalSpendUsd, 3)} · p50 {Math.round(e.p50ms)}ms · p95{" "}
          {Math.round(e.p95ms)}ms · active {e.activeJobs}
        </>
      );
    case "negotiation.message":
      return (
        <>
          {shortUri(e.from)} → {shortUri(e.to)} round {e.round} · {usd(e.proposal.priceUsd, 3)}
        </>
      );
    case "work.assigned":
      return (
        <>
          {e.contractId.slice(0, 12)}… → {e.capability} · deadline in{" "}
          {Math.max(0, Math.round((e.deadlineMs - Date.now()) / 1000))}s ·{" "}
          <span className="text-neutral-500">{truncate(e.brief, 50)}</span>
        </>
      );
    case "contract.timed_out":
      return (
        <>
          <span className="inline-block px-1.5 mr-1 rounded bg-evt-timeout/20 text-evt-timeout text-[9px] uppercase">
            timeout
          </span>
          {shortUri(e.bidderUri)} · contract {e.contractId.slice(0, 10)}… aged{" "}
          {Math.round(e.ageMs / 1000)}s
        </>
      );
    case "wallet.changed":
      // wallet.changed is filtered from the ticker ring buffer; live updates
      // land in the WalletStrip panel instead. Branch kept for type-exhaustiveness.
      return null;
    case "heartbeat":
      return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
