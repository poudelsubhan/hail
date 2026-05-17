/**
 * Keypress-driven demo presenter for stage. Prereq: `pnpm demo` is running
 * in another terminal. Press 1/2/3 to fire each scenario; q or Ctrl-C exits.
 *
 *   1 — Coframe: page-on-demand
 *   2 — OpenHome: home agent decomposes
 *   3 — Bidding war
 */
import { spawn } from "node:child_process";

const SCENARIOS: Record<string, { label: string; script: string }> = {
  "1": { label: "Coframe — page-on-demand", script: "scenario-page-render.ts" },
  "2": { label: "OpenHome — home agent delegates", script: "scenario-research.ts" },
  "3": { label: "Bidding war", script: "scenario-bidding-war.ts" },
};

function banner() {
  console.error("");
  console.error("┌─ agent classifieds — demo presenter ─────────────────────────┐");
  for (const [key, s] of Object.entries(SCENARIOS)) {
    console.error(`│  ${key}  →  ${s.label.padEnd(54)} │`);
  }
  console.error("│  q  →  quit                                                  │");
  console.error("└──────────────────────────────────────────────────────────────┘");
  console.error("");
}

let busy = false;
function run(key: string) {
  if (busy) {
    console.error("[presenter] busy — wait for the current scenario to finish");
    return;
  }
  const s = SCENARIOS[key];
  if (!s) return;
  busy = true;
  console.error(`\n[presenter] running: ${s.label}\n`);
  const proc = spawn("pnpm", ["--filter", "@ac/scripts", "exec", "tsx", s.script], {
    stdio: "inherit",
  });
  proc.on("exit", (code) => {
    busy = false;
    console.error(`\n[presenter] scenario finished (exit ${code})`);
    banner();
  });
}

banner();
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key) => {
  const k = String(key);
  if (k === "" || k === "q") {
    console.error("\n[presenter] bye");
    process.exit(0);
  }
  if (SCENARIOS[k]) run(k);
});
