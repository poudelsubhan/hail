/**
 * `pnpm demo` — boots coordinator (if not already running) + all 6 agents in
 * a single process so we can run scenarios against them. Logs to stderr;
 * Ctrl-C to stop.
 *
 * For multi-process boot (closer to real deployment) run each agent's file
 * standalone with tsx — the single-process variant is the demo-ergonomics
 * win, not a runtime requirement.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { SummarizerAgent } from "@ac/agents/summarizer";
import { SummarizerProAgent } from "@ac/agents/summarizer-pro";
import { TranslatorAgent } from "@ac/agents/translator";
import { SkepticAgent } from "@ac/agents/skeptic";
import { ImageDescriberAgent } from "@ac/agents/image-describer";
import { PageRendererAgent } from "@ac/agents/page-renderer";
import { ResearcherAgent } from "@ac/agents/researcher";

const COORD_URL = process.env.COORDINATOR_URL ?? "http://localhost:8787";

async function coordinatorAlive(): Promise<boolean> {
  try {
    const res = await fetch(COORD_URL + "/health");
    return res.ok;
  } catch {
    return false;
  }
}

async function bootCoordinator(): Promise<ChildProcess | null> {
  if (await coordinatorAlive()) {
    console.error("[demo] coordinator already running — skipping boot");
    return null;
  }
  console.error("[demo] starting coordinator…");
  const proc = spawn("pnpm", ["--filter", "@ac/coordinator", "start"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
  });
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await coordinatorAlive()) {
      console.error("[demo] coordinator up");
      return proc;
    }
  }
  proc.kill("SIGTERM");
  throw new Error("coordinator failed to come up within 9s");
}

async function main() {
  const coord = await bootCoordinator();

  const agents = [
    new SummarizerAgent(9101),
    new TranslatorAgent(9102),
    new SkepticAgent(9103),
    new ImageDescriberAgent(9104),
    new PageRendererAgent(9105),
    new ResearcherAgent(9106),
    new SummarizerProAgent(9107),
  ];

  for (const a of agents) {
    await a.start();
  }

  console.error("\n[demo] all agents online. press Ctrl-C to stop.\n");

  const shutdown = async () => {
    console.error("\n[demo] shutting down…");
    for (const a of agents) {
      try { await a.stop(); } catch { /* ignore */ }
    }
    if (coord) coord.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive forever.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[demo] fatal:", e);
  process.exit(1);
});
