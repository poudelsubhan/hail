/**
 * Scenario — OpenHome slice: "home agent delegates outward". A "home" poster
 * asks the Researcher to handle a real-world-shaped task. The Researcher
 * decomposes via Claude and hires summarizer + translator + image_describer
 * as sub-jobs.
 *
 * Prereqs: coordinator + all agents running (`pnpm demo`). This scenario
 * relies on multiple specialist agents being registered, so we don't boot
 * them inline — better to use `pnpm demo`.
 */
import { PosterAgent } from "@ac/agents/poster";
import { capabilityServed } from "@ac/agents/sdk";

const NEEDED = ["research", "summarize", "translate", "image_describe"];
for (const cap of NEEDED) {
  if (!(await capabilityServed(cap))) {
    console.error(
      `[scenario:research] capability "${cap}" not registered. Run \`pnpm demo\` first.`,
    );
    process.exit(1);
  }
}

const ws = new WebSocket(process.env.COORDINATOR_WS_URL ?? "ws://localhost:8787/ws");
ws.onmessage = (e) => {
  const evt = JSON.parse(e.data as string);
  if (evt.type === "heartbeat" || evt.type === "metrics.tick") return;
  console.log(" [ws]", evt.type, JSON.stringify(evt).slice(0, 200));
};
await new Promise<void>((r) => { ws.onopen = () => r(); });

const poster = new PosterAgent(0, `openhome-user-${process.pid}`);
await poster.start();
await new Promise((r) => setTimeout(r, 250));

const BRIEF = `I have these ingredients: chickpeas, spinach, garlic, lemon, cumin, olive oil.
Find a recipe, summarize the steps in three bullets, and translate the steps to Spanish.
Also describe what the finished dish looks like.`;

console.log("--- posting research job ---");
const t0 = Date.now();
const outcome = await poster.hireWork({
  capability: "research",
  brief: BRIEF,
  maxPriceUsd: 0.80,
  bidWindowMs: 4000,
  timeoutMs: 180_000,
});

console.log("--- outcome ---");
console.log("success   :", outcome.success);
console.log("latencyMs :", outcome.latencyMs);
console.log("wallMs    :", Date.now() - t0);
console.log("spendUsd  :", outcome.spendUsd);
console.log("result    :", JSON.stringify(outcome.result, null, 2));

console.log("\n--- spend rollups ---");
console.log(await (await fetch("http://localhost:8787/spend/total")).json());
console.log(await (await fetch("http://localhost:8787/spend/per-agent")).json());

await new Promise((r) => setTimeout(r, 500));
await poster.stop();
ws.close();
process.exit(0);
