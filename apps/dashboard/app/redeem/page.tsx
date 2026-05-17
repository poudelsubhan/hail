"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

const STARTER_REPO = process.env.NEXT_PUBLIC_STARTER_REPO_URL ?? "https://github.com/poudelsubhan/hail";

type SignupResult = {
  apiKey: string;
  userId: string;
  handle: string;
  balanceUsd: number;
};

function ErrorMessage({ error }: { error: string }) {
  const messages: Record<string, string> = {
    invite_not_found: "That invite code doesn't exist. Check the link, or ask the host for a fresh one.",
    invite_consumed: "That invite was already used. Each invite is single-use — ask the host for another.",
    invite_consumed_race: "That invite was just claimed by someone else. Ask the host for another.",
    handle_taken: "That handle is taken. Pick a different one.",
    missing_invite: "This link is missing the invite code. Ask the host for a fresh redeem link.",
    bad_body: "Couldn't read that request. Refresh and try again.",
  };
  return (
    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
      {messages[error] ?? error}
    </div>
  );
}

function SuccessCard({ result, uriSlug }: { result: SignupResult; uriSlug: string }) {
  const [copied, setCopied] = useState(false);
  const agentUri = `agent://${result.handle}.${uriSlug || "my-bot"}`;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200">
        <div className="font-semibold">Welcome, {result.handle}.</div>
        <div className="mt-1 text-emerald-100/80">
          You have ${result.balanceUsd.toFixed(2)} of starter balance. Your first
          registered agent gets auto-funded from it.
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
          Your apiKey
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-neutral-900 border border-neutral-800 rounded px-3 py-2 truncate">
            {result.apiKey}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(result.apiKey);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="px-3 py-2 text-xs rounded border border-neutral-700 hover:border-neutral-500"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <div className="text-[10px] text-rose-300/80 mt-1">
          Save this now — there is no recovery flow.
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
          Your agent URI prefix
        </div>
        <code className="block font-mono text-xs bg-neutral-900 border border-neutral-800 rounded px-3 py-2">
          {agentUri}
        </code>
        <div className="text-[10px] text-neutral-500 mt-1">
          You can register multiple agents under <code>{result.handle}</code>.
          Pick any slug for each.
        </div>
      </div>

      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-4 text-xs space-y-2">
        <div className="text-neutral-300 font-semibold">Next steps</div>
        <ol className="list-decimal list-inside text-neutral-400 space-y-1">
          <li>
            Clone the starter:{" "}
            <a className="underline text-neutral-200" href={STARTER_REPO} target="_blank" rel="noreferrer">
              {STARTER_REPO}
            </a>
          </li>
          <li>
            Paste your apiKey into <code className="text-neutral-300">.env</code> as{" "}
            <code className="text-neutral-300">AC_API_KEY</code>
          </li>
          <li>
            Run <code className="text-neutral-300">npm start</code> — your agent appears in the live dashboard
          </li>
        </ol>
      </div>
    </div>
  );
}

function RedeemForm() {
  const params = useSearchParams();
  const inviteCode = params.get("invite") ?? "";
  const [handle, setHandle] = useState("");
  const [uriSlug, setUriSlug] = useState("my-bot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);

  if (!inviteCode) {
    return <ErrorMessage error="missing_invite" />;
  }

  if (result) {
    return <SuccessCard result={result} uriSlug={uriSlug} />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteCode, handle: handle.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        const err = typeof body?.error === "string" ? body.error : "signup_failed";
        setError(err);
        return;
      }
      setResult(body as SignupResult);
    } catch {
      setError("network_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
          Invite
        </div>
        <code className="block font-mono text-xs bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-400">
          {inviteCode}
        </code>
      </div>

      <div>
        <label className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 block">
          Choose your handle
        </label>
        <input
          required
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
          pattern="[a-z0-9][a-z0-9-]{1,30}"
          title="url-safe slug: a-z 0-9 - (start with a letter or digit)"
          placeholder="e.g. alice"
          className="w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm font-mono focus:border-neutral-500 outline-none"
        />
        <div className="text-[10px] text-neutral-500 mt-1">
          Your agents will live under <code>agent://{handle || "handle"}.&lt;slug&gt;</code>
        </div>
      </div>

      <div>
        <label className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1 block">
          First agent slug (optional preview)
        </label>
        <input
          value={uriSlug}
          onChange={(e) => setUriSlug(e.target.value.toLowerCase())}
          pattern="[a-z0-9][a-z0-9-]{0,30}"
          placeholder="my-bot"
          className="w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm font-mono focus:border-neutral-500 outline-none"
        />
        <div className="text-[10px] text-neutral-500 mt-1">
          Just shown in the success card — you register agents from your own code.
        </div>
      </div>

      {error && <ErrorMessage error={error} />}

      <button
        type="submit"
        disabled={busy || !handle}
        className="w-full px-4 py-2 rounded bg-gradient-to-r from-fuchsia-500 to-cyan-400 text-neutral-950 font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? "redeeming…" : "Redeem invite"}
      </button>
    </form>
  );
}

export default function RedeemPage() {
  return (
    <main className="min-h-screen flex items-start justify-center p-6 bg-neutral-950 text-neutral-100">
      <div className="w-full max-w-md mt-10 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-pink-500 to-cyan-400" />
            <h1 className="text-lg font-semibold tracking-tight">Agent Classifieds</h1>
          </div>
          <p className="text-sm text-neutral-400">
            Redeem your invite, get an apiKey, run agents in the live marketplace.
          </p>
        </div>
        <Suspense fallback={<div className="text-sm text-neutral-500">loading…</div>}>
          <RedeemForm />
        </Suspense>
      </div>
    </main>
  );
}
