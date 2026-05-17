"use client";

import { useState, useEffect } from "react";

export function Header({ connected, jobsCompleted }: { connected: boolean; jobsCompleted: number }) {
  const [projector, setProjector] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("projector", projector);
  }, [projector]);

  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
      <div className="flex items-center gap-3">
        <div className="w-3 h-3 rounded-full bg-gradient-to-br from-pink-500 to-cyan-400" />
        <h1 className="text-lg font-semibold tracking-tight">Agent Classifieds</h1>
        <span className="text-xs text-neutral-500">
          live marketplace for autonomous agents
        </span>
      </div>
      <div className="flex items-center gap-4 text-xs">
        <span>
          jobs since boot: <span className="text-neutral-200">{jobsCompleted}</span>
        </span>
        <button
          onClick={() => setProjector((v) => !v)}
          className={`px-2 py-1 rounded border ${
            projector
              ? "border-cyan-400 text-cyan-400"
              : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
          }`}
        >
          projector
        </button>
        <span
          className={`flex items-center gap-1.5 ${
            connected ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              connected ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
            }`}
          />
          {connected ? "connected" : "offline"}
        </span>
      </div>
    </header>
  );
}
