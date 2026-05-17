/**
 * Scenario 3 — bidding war. Two summarizers fight for the same well-priced
 * job, escalating undercuts round-by-round. The Skeptic chimes in via
 * `negotiation.message` when bids drop below its threshold. Crowd-pleaser.
 *
 * Prereqs: coordinator running, plus the two summarizers + skeptic. `pnpm
 * demo` boots them all.
 */
import { PosterAgent } from "@ac/agents/poster";
import { capabilityServed } from "@ac/agents/sdk";

// Make sure the cast of characters is present.
for (const cap of ["summarize", "verify"]) {
  if (!(await capabilityServed(cap))) {
    console.error(
      `[scenario:bidding-war] capability "${cap}" not registered. Run \`pnpm demo\` first.`,
    );
    process.exit(1);
  }
}

const ws = new WebSocket("ws://localhost:8787/ws");
ws.onmessage = (e) => {
  const evt = JSON.parse(e.data as string);
  if (evt.type === "heartbeat" || evt.type === "metrics.tick") return;
  console.log(" [ws]", evt.type, JSON.stringify(evt).slice(0, 220));
};
await new Promise<void>((r) => { ws.onopen = () => r(); });

const poster = new PosterAgent(0, `auction-buyer-${process.pid}`);
await poster.start();
await new Promise((r) => setTimeout(r, 250));

const BRIEF = `Manifesto: agent-native commerce removes pre-arranged accounts. HTTP 402 + signed proofs let strangers transact in one shot. Reputation is local, portable, and computed from observable behavior, not vendor allowlists.`;

console.log("--- posting job with generous budget — both summarizers will fight ---");
const t0 = Date.now();
// Long bid window so the auction has time to play out
const outcome = await poster.hireWork({
  capability: "summarize",
  brief: BRIEF,
  maxPriceUsd: 0.30,
  bidWindowMs: 8000,
  timeoutMs: 60_000,
});

console.log("\n--- outcome ---");
console.log("success    :", outcome.success);
console.log("latencyMs  :", outcome.latencyMs);
console.log("wallMs     :", Date.now() - t0);
console.log("spendUsd   :", outcome.spendUsd);
console.log("result     :", JSON.stringify(outcome.result, null, 2));

await new Promise((r) => setTimeout(r, 500));
await poster.stop();
ws.close();
process.exit(0);
