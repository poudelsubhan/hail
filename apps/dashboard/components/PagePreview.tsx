"use client";

import { useEffect, useState } from "react";

/**
 * Inline iframe preview for `job.completed` results carrying a URL. The
 * Coframe demo lives here — when the page-renderer delivers, the rendered
 * page appears inline next to the ticker.
 */
export function PagePreview({
  preview,
}: {
  preview: { url: string; title: string; jobId: string } | null;
}) {
  const [open, setOpen] = useState(true);
  const [iframeKey, setIframeKey] = useState(0);

  // Re-mount the iframe when a new preview arrives so we don't keep stale content.
  useEffect(() => {
    if (preview) {
      setIframeKey((k) => k + 1);
      setOpen(true);
    }
  }, [preview?.url]);

  if (!preview) return null;
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 px-3 py-2 rounded border border-cyan-500 text-cyan-300 text-xs bg-neutral-950"
      >
        reopen preview
      </button>
    );
  }
  return (
    <div className="fixed bottom-4 right-4 w-[420px] h-[480px] rounded-lg border border-cyan-500/40 bg-neutral-950 shadow-2xl overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 text-xs">
        <div className="truncate">
          <span className="text-neutral-500">rendered page · </span>
          <span className="text-cyan-300">{preview.jobId.slice(0, 12)}…</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            className="text-neutral-400 hover:text-neutral-200"
          >
            open
          </a>
          <button
            onClick={() => setOpen(false)}
            className="text-neutral-400 hover:text-neutral-200"
            aria-label="close"
          >
            ✕
          </button>
        </div>
      </div>
      <iframe
        key={iframeKey}
        src={preview.url}
        className="flex-1 w-full bg-white"
        sandbox="allow-scripts"
        title={preview.title}
      />
    </div>
  );
}
