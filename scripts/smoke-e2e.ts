/**
 * End-to-end smoke test for Track A: register → post → bid → accept (402) →
 * settle → deliver. Also opens a WS connection on the side and prints every
 * event so you can see the full lifecycle on the bus.
 */

const BASE = "http://localhost:8787";

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  return { status: res.status, data, headers: res.headers };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  return (await res.json()) as T;
}

// Tap the WS for visibility.
const ws = new WebSocket("ws://localhost:8787/ws");
const seen: string[] = [];
ws.onmessage = (e) => {
  const evt = JSON.parse(e.data as string);
  if (evt.type === "heartbeat" || evt.type === "metrics.tick") return;
  seen.push(evt.type);
  console.log(" [ws]", evt.type, JSON.stringify(evt).slice(0, 200));
};
await new Promise<void>((r) => { ws.onopen = () => r(); });

const POSTER = "agent://test-poster.local";
const BIDDER = "agent://test-bidder.local";

// 1. Register two agents
await post("/registry/register", {
  uri: POSTER, url: "http://localhost:9001",
  capabilities: ["__test__"], pubkey: "stub",
});
await post("/registry/register", {
  uri: BIDDER, url: "http://localhost:9002",
  capabilities: ["summarize"], pubkey: "stub",
});

// 2. Lookup
const lookup = await get<{ agents: { uri: string }[] }>(
  "/registry/lookup?capability=summarize",
);
console.log("lookup matches:", lookup.agents.map((a) => a.uri));

// 3. Post a job
const job = await post<{ jobId: string }>("/jobs", {
  posterUri: POSTER,
  capability: "summarize",
  brief: "summarize the constitution in 3 bullets",
  maxPriceUsd: 0.10,
});
console.log("jobId:", job.data.jobId);

// 4. Place a bid
const bid = await post<{ bidId: string }>(`/jobs/${job.data.jobId}/bid`, {
  bidderUri: BIDDER,
  priceUsd: 0.04,
  etaSec: 8,
  note: "smoke",
});
console.log("bidId:", bid.data.bidId);

// 5. Accept → expect HTTP 402 + challenge in body and header
const acc = await post<{ contractId: string; challenge: { nonce: string; amountUsd: number } }>(
  `/jobs/${job.data.jobId}/accept`,
  { bidId: bid.data.bidId },
);
console.log("accept status:", acc.status);
console.log("X-Payment-Required:", acc.headers.get("x-payment-required"));
const { contractId, challenge } = acc.data;

// 6. Settle
const settled = await post<{ paymentProof: string }>("/x402/settle", {
  nonce: challenge.nonce,
  amountUsd: challenge.amountUsd,
  from: POSTER,
});
console.log("paymentProof (truncated):", settled.data.paymentProof.slice(0, 40), "…");

// 7. Deliver
const delivered = await post<{ receiptId: string }>(
  `/contracts/${contractId}/deliver`,
  {
    result: { summary: ["agents have URIs", "jobs have states", "x402 settles in HMAC"] },
    paymentProof: settled.data.paymentProof,
  },
);
console.log("receiptId:", delivered.data.receiptId);

// 8. Receipts roll-up
const receipts = await get<{ receipts: unknown[] }>("/receipts");
console.log("receipt count:", receipts.receipts.length);

// 9. Health
const health = await get<unknown>("/health");
console.log("health:", health);

await new Promise((r) => setTimeout(r, 1500));
console.log("ws events observed (non-heartbeat):", seen);
ws.close();
process.exit(0);
