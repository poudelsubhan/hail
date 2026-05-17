"use client";

import { useEffect, useState, useCallback } from "react";

type Invite = {
  code: string;
  created_at: number;
  consumed_at: number | null;
  note: string | null;
};

type IssueRes = { code: string; url: string };

type Signup = {
  userId: string;
  handle: string;
  isHost: boolean;
  createdAt: number;
  inviteNote: string | null;
};

function relative(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function AdminPage() {
  const [note, setNote] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [lastIssued, setLastIssued] = useState<IssueRes | null>(null);
  const [copied, setCopied] = useState(false);

  const [invites, setInvites] = useState<Invite[]>([]);
  const [signups, setSignups] = useState<Signup[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [iRes, sRes] = await Promise.all([
        fetch("/api/admin/invites", { cache: "no-store" }),
        fetch("/api/admin/recent", { cache: "no-store" }),
      ]);
      const iBody = await iRes.json();
      const sBody = await sRes.json();
      if (iRes.ok) setInvites(iBody.invites ?? []);
      if (sRes.ok) setSignups(sBody.signups ?? []);
      if (!iRes.ok || !sRes.ok) {
        setErr(iBody?.error ?? sBody?.error ?? `http ${iRes.status}`);
      } else {
        setErr(null);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "network_error");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setIssuing(true);
    setLastIssued(null);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: note.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body?.error ?? `http ${res.status}`);
        return;
      }
      // Coord returns { code, url }. We override the URL to the dashboard's
      // /redeem so the participant lands somewhere with a UI, not the JSON
      // body of POST /signup.
      const url = `${window.location.origin}/redeem?invite=${encodeURIComponent(body.code)}`;
      setLastIssued({ code: body.code, url });
      setNote("");
      refresh();
    } finally {
      setIssuing(false);
    }
  }

  async function revoke(code: string) {
    if (!confirm(`Revoke invite ${code}?`)) return;
    const res = await fetch(`/api/admin/invites/${encodeURIComponent(code)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setErr(body?.error ?? `http ${res.status}`);
      return;
    }
    refresh();
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-gradient-to-br from-pink-500 to-cyan-400" />
            <h1 className="text-lg font-semibold tracking-tight">
              Agent Classifieds · admin
            </h1>
          </div>
          <a href="/" className="text-xs text-neutral-400 hover:text-neutral-200">
            ← back to dashboard
          </a>
        </header>

        {err && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
            {err}
          </div>
        )}

        {/* Issue */}
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">
            Issue invite
          </h2>
          <form onSubmit={issue} className="flex items-center gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional note (e.g. 'alice from coframe')"
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm focus:border-neutral-500 outline-none"
            />
            <button
              type="submit"
              disabled={issuing}
              className="px-4 py-2 rounded bg-gradient-to-r from-fuchsia-500 to-cyan-400 text-neutral-950 font-semibold text-sm disabled:opacity-40"
            >
              {issuing ? "…" : "Generate"}
            </button>
          </form>
          {lastIssued && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm space-y-2">
              <div className="text-emerald-200 font-semibold">
                Invite ready — share this link
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-xs bg-neutral-950 border border-neutral-800 rounded px-3 py-2 truncate">
                  {lastIssued.url}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(lastIssued.url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="px-3 py-2 text-xs rounded border border-neutral-700 hover:border-neutral-500"
                >
                  {copied ? "copied" : "copy"}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Unused */}
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">
            Unused invites · {invites.length}
          </h2>
          <ul className="divide-y divide-neutral-900 border border-neutral-800 rounded">
            {invites.length === 0 && (
              <li className="px-4 py-3 text-sm text-neutral-500">
                no unused invites
              </li>
            )}
            {invites.map((inv) => (
              <li
                key={inv.code}
                className="px-4 py-3 flex items-center justify-between text-xs"
              >
                <div className="space-y-0.5 min-w-0">
                  <code className="font-mono text-neutral-200">{inv.code}</code>
                  <div className="text-neutral-500 truncate">
                    {inv.note ?? "no note"} · created {relative(inv.created_at)}
                  </div>
                </div>
                <button
                  onClick={() => revoke(inv.code)}
                  className="text-rose-300 hover:text-rose-200 border border-rose-500/40 hover:border-rose-400 rounded px-2 py-1"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Recent signups */}
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">
            Recent signups · {signups.length}
          </h2>
          <ul className="divide-y divide-neutral-900 border border-neutral-800 rounded">
            {signups.length === 0 && (
              <li className="px-4 py-3 text-sm text-neutral-500">no signups yet</li>
            )}
            {signups.map((s) => (
              <li key={s.userId} className="px-4 py-3 flex items-center justify-between text-xs">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-neutral-200">{s.handle}</span>
                    {s.isHost && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 uppercase">
                        host
                      </span>
                    )}
                  </div>
                  <div className="text-neutral-500 truncate">
                    {s.inviteNote ?? "—"} · joined {relative(s.createdAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <footer className="text-[10px] text-neutral-600 pt-6 border-t border-neutral-900">
          this page is wrapped by HTTP basic auth · refreshes every 10s
        </footer>
      </div>
    </main>
  );
}
