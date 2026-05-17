/**
 * Scenario — Coframe slice: "page-on-demand". A poster asks for a landing
 * page; the page-renderer bids, generates Tailwind HTML via Claude (Sonnet),
 * hosts at `<agent.url>/pages/<id>`, returns the URL in deliver. Dashboard
 * inline-previews via iframe (Track B).
 *
 * Prereqs: coordinator running. Either `pnpm demo` is up (recommended — the
 * page-renderer is then preloaded) OR this script boots one inline.
 */
import { PageRendererAgent } from "@ac/agents/page-renderer";
import { PosterAgent } from "@ac/agents/poster";
import { capabilityServed } from "@ac/agents/sdk";

const ws = new WebSocket(process.env.COORDINATOR_WS_URL ?? "ws://localhost:8787/ws");
ws.onmessage = (e) => {
  const evt = JSON.parse(e.data as string);
  if (evt.type === "heartbeat" || evt.type === "metrics.tick") return;
  console.log(" [ws]", evt.type, JSON.stringify(evt).slice(0, 220));
};
await new Promise<void>((r) => { ws.onopen = () => r(); });

const rendererUp = await capabilityServed("render_page");
console.log(`--- booting agents (page-renderer already up: ${rendererUp}) ---`);

const renderer = rendererUp ? null : new PageRendererAgent(0);
const poster = new PosterAgent(0, `coframe-buyer-${process.pid}`);

if (renderer) await renderer.start();
await poster.start();
await new Promise((r) => setTimeout(r, 250));

const BRIEF = `Generative-web tool for marketing teams. Hero: "Ship a page in a sentence."
Three-card feature grid: AI prompts, real-time preview, one-click publish.
Dark mode by default. CTA buttons "Start free" and "Watch demo".`;

console.log("--- posting render_page job ---");
const t0 = Date.now();
const outcome = await poster.hireWork({
  capability: "render_page",
  brief: BRIEF,
  maxPriceUsd: 0.50,
  bidWindowMs: 4000,
  timeoutMs: 90_000,
});

console.log("--- outcome ---");
console.log("success   :", outcome.success);
console.log("latencyMs :", outcome.latencyMs);
console.log("wallMs    :", Date.now() - t0);
console.log("spendUsd  :", outcome.spendUsd);
console.log("result    :", outcome.result);

const result = outcome.result as { url?: string };
if (result?.url) {
  console.log("\nfetching rendered page…");
  const r = await fetch(result.url);
  const html = await r.text();
  console.log(`status=${r.status} bytes=${html.length}`);
  console.log("head:", html.slice(0, 240).replace(/\n/g, " "));
}

await new Promise((r) => setTimeout(r, 500));
if (renderer) await renderer.stop();
await poster.stop();
ws.close();
process.exit(0);
