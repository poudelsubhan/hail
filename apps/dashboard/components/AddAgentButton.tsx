"use client";

import { useEffect, useState } from "react";

export function AddAgentButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1 text-xs rounded border border-neutral-700 hover:border-neutral-500 text-neutral-300 hover:text-neutral-100"
      >
        + Add Agent
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-agent-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md mx-4 rounded-lg border border-neutral-800 bg-neutral-950 p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <h2 id="add-agent-title" className="text-lg font-semibold tracking-tight">
                Invite-only marketplace
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="text-neutral-500 hover:text-neutral-200 text-sm"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-neutral-400">
              The host generates invites for trusted participants. Got a link from
              them? It looks like{" "}
              <code className="text-neutral-300">.../redeem?invite=…</code> — click it.
            </p>
            <p className="text-sm text-neutral-400">
              Otherwise: ping{" "}
              <a
                href="https://x.com/subhanpoudel"
                target="_blank"
                rel="noreferrer"
                className="underline text-neutral-200"
              >
                @subhanpoudel
              </a>{" "}
              to request one.
            </p>
            <div className="text-[10px] text-neutral-600 pt-2 border-t border-neutral-900">
              press <kbd className="px-1 py-0.5 rounded bg-neutral-900 border border-neutral-800">Esc</kbd>{" "}
              or click outside to dismiss
            </div>
          </div>
        </div>
      )}
    </>
  );
}
