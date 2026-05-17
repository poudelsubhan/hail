/**
 * Scenario smoke: post a summarize job, watch the full lifecycle. Works
 * whether or not `pnpm demo` is already running — if a summarizer is already
 * registered we reuse it; otherwise we boot one inline.
 *
 * Prereqs: coordinator running (`pnpm coordinator`), ANTHROPIC_API_KEY in .env.
 */
import { SummarizerAgent } from "@ac/agents/summarizer";
import { PosterAgent } from "@ac/agents/poster";
import { capabilityServed } from "@ac/agents/sdk";

const ws = new WebSocket("ws://localhost:8787/ws");
ws.onmessage = (e) => {
  const evt = JSON.parse(e.data as string);
  if (evt.type === "heartbeat" || evt.type === "metrics.tick") return;
  console.log(" [ws]", evt.type, JSON.stringify(evt).slice(0, 240));
};
await new Promise<void>((r) => { ws.onopen = () => r(); });

const summarizerAlreadyUp = await capabilityServed("summarize");
console.log(`--- booting agents (summarizer already up: ${summarizerAlreadyUp}) ---`);

const summarizer = summarizerAlreadyUp ? null : new SummarizerAgent(0);
// Unique slug + auto-port so this can run alongside pnpm demo and other scenarios.
const poster = new PosterAgent(0, `summarize-buyer-${process.pid}`);

if (summarizer) await summarizer.start();
await poster.start();
await new Promise((r) => setTimeout(r, 250));

const BRIEF = `The x402 standard proposes that HTTP 402 ("Payment Required") be reused as a generic, machine-readable handshake: the server responds with the status, the client retrieves payment instructions from a header, settles via the named endpoint, and re-issues the request with a signed proof. Designed for agent-to-agent commerce, it removes the need for pre-arranged accounts and enables one-shot, micro-priced exchanges between strangers.`;

console.log("--- posting job ---");
const t0 = Date.now();
const outcome = await poster.hireWork({
  capability: "summarize",
  brief: BRIEF,
  maxPriceUsd: 0.10,
  bidWindowMs: 4000,
  timeoutMs: 30_000,
});
const wallMs = Date.now() - t0;

console.log("--- outcome ---");
console.log("success     :", outcome.success);
console.log("latencyMs   :", outcome.latencyMs, "(post → completed)");
console.log("wallMs      :", wallMs);
console.log("spendUsd    :", outcome.spendUsd);
console.log("result      :", JSON.stringify(outcome.result, null, 2));

await new Promise((r) => setTimeout(r, 500));
console.log("--- spend rollups ---");
console.log("total       :", await (await fetch("http://localhost:8787/spend/total")).json());
console.log("per-agent   :", await (await fetch("http://localhost:8787/spend/per-agent")).json());

if (summarizer) await summarizer.stop();
await poster.stop();
ws.close();
process.exit(0);
