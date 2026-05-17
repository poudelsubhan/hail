/**
 * Phase 2 smoke test — exercises the full v2 marketplace without using the
 * v1 SDK (which doesn't yet send apiKeys). Drives the coordinator's REST +
 * WS layer directly.
 *
 * Run: pnpm --filter @ac/scripts exec tsx smoke-phase2.ts
 *
 * Requires:
 *  - Coordinator running on $COORDINATOR_URL (default http://localhost:8787)
 *  - AC_HOST_API_KEY in env, matching the host user in the DB
 */
import WebSocket from "ws";

const COORD = process.env.COORDINATOR_URL ?? "http://localhost:8787";
const COORD_WS = process.env.COORDINATOR_WS_URL ?? "ws://localhost:8787/ws";
const HOST_KEY = process.env.AC_HOST_API_KEY;
if (!HOST_KEY) {
  console.error("AC_HOST_API_KEY required in env");
  process.exit(1);
}

type Json = Record<string, unknown>;
async function req(path: string, init: RequestInit & { auth?: string } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any) };
  if (init.auth) headers["Authorization"] = `Bearer ${init.auth}`;
  const res = await fetch(`${COORD}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

const log = (label: string, status: number, body: unknown) =>
  console.log(`[${status}] ${label}`, typeof body === "string" ? body : JSON.stringify(body));

async function expect(cond: boolean, msg: string) {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

async function main() {
  console.log("=== Phase 2 smoke ===");

  // 1. Host issues two invites
  const i1 = await req("/invites", { method: "POST", body: JSON.stringify({ note: "smoke-poster" }), auth: HOST_KEY });
  const i2 = await req("/invites", { method: "POST", body: JSON.stringify({ note: "smoke-bidder" }), auth: HOST_KEY });
  log("invite poster", i1.status, i1.body);
  log("invite bidder", i2.status, i2.body);
  await expect(i1.status === 200 && i2.status === 200, "invites issued");

  // 2. Sign up two users (random handles so reruns work)
  const sfx = Math.random().toString(36).slice(2, 7);
  const posterHandle = `pst-${sfx}`;
  const bidderHandle = `bid-${sfx}`;
  const s1 = await req("/signup", { method: "POST", body: JSON.stringify({ inviteCode: i1.body.code, handle: posterHandle }) });
  const s2 = await req("/signup", { method: "POST", body: JSON.stringify({ inviteCode: i2.body.code, handle: bidderHandle }) });
  log("signup poster", s1.status, s1.body);
  log("signup bidder", s2.status, s2.body);
  await expect(s1.status === 200 && s2.status === 200, "signups");
  const posterKey = s1.body.apiKey as string;
  const bidderKey = s2.body.apiKey as string;
  await expect(s1.body.balanceUsd === 5 && s2.body.balanceUsd === 5, "$5 starting balance");

  // 3. Each user registers an agent under their own handle (v2 URI form)
  const posterUri = `agent://${posterHandle}.poster`;
  const bidderUri = `agent://${bidderHandle}.bidder`;
  const r1 = await req("/registry/register", {
    method: "POST",
    body: JSON.stringify({ uri: posterUri, url: "http://example.invalid", capabilities: ["summarize"], pubkey: "pk_poster" }),
    auth: posterKey,
  });
  const r2 = await req("/registry/register", {
    method: "POST",
    body: JSON.stringify({ uri: bidderUri, url: "http://example.invalid", capabilities: ["summarize"], pubkey: "pk_bidder" }),
    auth: bidderKey,
  });
  log("register poster agent", r1.status, r1.body);
  log("register bidder agent", r2.status, r2.body);
  await expect(r1.status === 200 && r2.status === 200, "agent registrations");

  // 3b. URI namespacing — bidder tries to register under poster's handle
  const rWrong = await req("/registry/register", {
    method: "POST",
    body: JSON.stringify({ uri: `agent://${posterHandle}.stolen`, url: "http://x.invalid", capabilities: ["x"], pubkey: "pk_x" }),
    auth: bidderKey,
  });
  log("bidder steals poster handle", rWrong.status, rWrong.body);
  await expect(rWrong.status === 403, "URI handle mismatch is rejected");

  // 4. Open a WS subscription for the bidder (authed) so we can catch work.assigned.
  const ws = new WebSocket(`${COORD_WS}?apiKey=${encodeURIComponent(bidderKey)}`);
  const events: any[] = [];
  ws.on("message", (data) => {
    const evt = JSON.parse(data.toString());
    events.push(evt);
  });
  await new Promise((res, rej) => {
    ws.once("open", () => res(null));
    ws.once("error", rej);
    setTimeout(() => rej(new Error("ws open timeout")), 3000);
  });
  // Give the lazy import a moment to tag the socket.
  await new Promise((r) => setTimeout(r, 300));

  // 5. Poster posts a job (within $5 balance)
  const jobReq = await req("/jobs", {
    method: "POST",
    body: JSON.stringify({ posterUri, capability: "summarize", brief: "smoke brief", maxPriceUsd: 1.0 }),
    auth: posterKey,
  });
  log("post job", jobReq.status, jobReq.body);
  await expect(jobReq.status === 200, "job posted");
  const jobId = jobReq.body.jobId as string;

  // 6. Bidder places a bid (etaSec=4 → deadline = 8s)
  const bidReq = await req(`/jobs/${jobId}/bid`, {
    method: "POST",
    body: JSON.stringify({ bidderUri, priceUsd: 0.5, etaSec: 4, note: "smoke bid" }),
    auth: bidderKey,
  });
  log("place bid", bidReq.status, bidReq.body);
  await expect(bidReq.status === 200, "bid placed");
  const bidId = bidReq.body.bidId as string;

  // 7. Poster accepts → 402 + escrow debited
  const acc = await req(`/jobs/${jobId}/accept`, {
    method: "POST",
    body: JSON.stringify({ bidId }),
    auth: posterKey,
  });
  log("accept", acc.status, acc.body);
  await expect(acc.status === 402, "accept returns 402");
  const contractId = acc.body.contractId as string;
  const challenge = acc.body.challenge;

  // Balance check after escrow
  const mePost = await req("/me", { auth: posterKey });
  await expect(mePost.body.balanceUsd === 4.5, `poster balance debited 0.50 → 4.50 (got ${mePost.body.balanceUsd})`);

  // 8. Poster settles → bidder should get work.assigned via WS
  const set = await req("/x402/settle", {
    method: "POST",
    body: JSON.stringify({ nonce: challenge.nonce, amountUsd: challenge.amountUsd, from: posterUri }),
    auth: posterKey,
  });
  log("settle", set.status, set.body);
  await expect(set.status === 200, "settle ok");

  // Wait for work.assigned
  const deadlineWait = Date.now() + 3000;
  while (Date.now() < deadlineWait) {
    if (events.find((e) => e.type === "work.assigned" && e.contractId === contractId)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const wa = events.find((e) => e.type === "work.assigned" && e.contractId === contractId);
  console.log("work.assigned event:", JSON.stringify(wa));
  await expect(!!wa, "bidder received work.assigned over authed WS");
  await expect(
    wa.brief === "smoke brief" && wa.capability === "summarize" && wa.bidderUri === bidderUri,
    "work.assigned payload (including bidderUri)",
  );

  // 9. Bidder delivers
  const del = await req(`/contracts/${contractId}/deliver`, {
    method: "POST",
    body: JSON.stringify({ result: { ok: true }, paymentProof: wa.paymentProof }),
    auth: bidderKey,
  });
  log("deliver", del.status, del.body);
  await expect(del.status === 200, "deliver ok");

  // 10. Balances after settle: poster 4.50, bidder 5.50
  const meP = await req("/me", { auth: posterKey });
  const meB = await req("/me", { auth: bidderKey });
  console.log("poster:", meP.body, "bidder:", meB.body);
  await expect(meP.body.balanceUsd === 4.5 && meB.body.balanceUsd === 5.5, "balances reflect transfer");

  // 11. Insufficient balance check — try to post a $100 job as poster
  const big = await req("/jobs", {
    method: "POST",
    body: JSON.stringify({ posterUri, capability: "summarize", brief: "too big", maxPriceUsd: 100 }),
    auth: posterKey,
  });
  log("oversized job", big.status, big.body);
  await expect(big.status === 402 && big.body.error === "insufficient_balance", "insufficient_balance gate");

  // 12. Timeout path: post + accept + DON'T settle on the bidder side.
  //     etaSec=1 → deadline=2s → sweeper fires within 4s.
  const jobT = await req("/jobs", {
    method: "POST",
    body: JSON.stringify({ posterUri, capability: "summarize", brief: "timeout test", maxPriceUsd: 1.0 }),
    auth: posterKey,
  });
  await expect(jobT.status === 200, "timeout job posted");
  const tJobId = jobT.body.jobId;
  const bidT = await req(`/jobs/${tJobId}/bid`, {
    method: "POST",
    body: JSON.stringify({ bidderUri, priceUsd: 0.25, etaSec: 1 }),
    auth: bidderKey,
  });
  await expect(bidT.status === 200, "timeout bid placed");
  const accT = await req(`/jobs/${tJobId}/accept`, {
    method: "POST",
    body: JSON.stringify({ bidId: bidT.body.bidId }),
    auth: posterKey,
  });
  await expect(accT.status === 402, "timeout accept ok");
  const tContractId = accT.body.contractId;

  const meBefore = await req("/me", { auth: posterKey });
  console.log("poster before timeout:", meBefore.body.balanceUsd);

  // Don't settle — wait for sweeper. deadline=2000ms, sweeper tick=2000ms → ≤5s
  console.log("waiting ~6s for sweeper...");
  await new Promise((r) => setTimeout(r, 6500));

  const meAfter = await req("/me", { auth: posterKey });
  console.log("poster after timeout:", meAfter.body.balanceUsd);
  await expect(
    Math.abs(meAfter.body.balanceUsd - (meBefore.body.balanceUsd + 0.25)) < 1e-6,
    "escrow refunded on timeout",
  );
  const timeoutEvt = events.find(
    (e) => e.type === "contract.timed_out" && e.contractId === tContractId,
  );
  console.log("contract.timed_out event:", JSON.stringify(timeoutEvt));
  await expect(!!timeoutEvt, "contract.timed_out emitted");

  ws.close();
  console.log("\n=== Phase 2 smoke PASSED ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
