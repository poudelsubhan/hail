import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { bus } from "./bus.js";
import { store } from "./store.js";
import { startMetricsTick } from "./metrics.js";
import { registryRoutes } from "./routes/registry.js";
import { jobsRoutes } from "./routes/jobs.js";
import { contractsRoutes } from "./routes/contracts.js";
import { x402Routes } from "./routes/x402.js";
import { spendRoutes } from "./routes/spend.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { negotiationRoutes } from "./routes/negotiation.js";
import { authRoutes } from "./routes/auth.js";
import { llmRoutes } from "./routes/llm.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { walletsRoutes } from "./routes/wallets.js";
import { registerAuth } from "./auth.js";
import { bootstrapHost } from "./bootstrap.js";
import { startDeadlineSweeper } from "./sweeper.js";
import { runBootSmoke } from "./smoke-on-boot.js";
import { setClaudeLogSink } from "@ac/llm";

const PORT = Number(process.env.COORDINATOR_PORT ?? 8787);

const app = Fastify({ logger: { level: "info" } });
// Permissive CORS — the dashboard runs on :3000 and the page-renderer's
// rendered pages are iframed from arbitrary agent ports. Demo-grade only.
await app.register(cors, { origin: true });
await app.register(websocket);

// Initialize SQLite (creates data/ac.db, runs schema) and materialize the
// host user on first boot.
bootstrapHost();

// Auth preHandler — attaches req.user from Bearer apiKey; gates mutating routes.
await registerAuth(app);

// Health + introspection
app.get("/health", async () => ({
  ok: true,
  subs: bus.size(),
  agents: store.agents.size,
  jobs: store.jobs.size,
  contracts: store.contracts.size,
  ts: Date.now(),
}));

// Friendly landing for humans who hit the API root in a browser.
// The dashboard lives on a separate Vercel deployment — this is just
// the coordinator/API, not a site.
app.get("/", async () => ({
  service: "concord-coordinator",
  ok: true,
  hint: "JSON API. The browsable dashboard is a separate deployment.",
  routes: [
    "GET  /health",
    "GET  /registry/agents",
    "GET  /registry/lookup?capability=<tag>",
    "GET  /wallets",
    "GET  /jobs/:id",
    "GET  /receipts?since=<ms>",
    "GET  /admin/recent  (host Bearer)",
    "POST /signup  (anonymous, needs invite)",
    "POST /invites  (host Bearer)",
    "POST /jobs · /jobs/:id/bid · /jobs/:id/accept (authed)",
    "POST /x402/settle · /contracts/:id/deliver (authed)",
    "WS   /ws  (broadcast events; ?apiKey=... for direct push)",
  ],
}));

// WS subscribers. Anonymous connections get broadcast events (dashboard).
// Connections with `?apiKey=...` resolve to a user and additionally receive
// direct-push events like `work.assigned`.
app.get("/ws", { websocket: true }, (socket, req) => {
  bus.subscribe(socket);
  socket.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
  const q = req.query as { apiKey?: string };
  if (q.apiKey) {
    // Import lazily to avoid a circular import at module top-level.
    import("./db/index.js").then(({ dao }) => {
      const u = dao.findUserByApiKey(q.apiKey!);
      if (u) bus.tagSocket(socket, u.id);
    });
  }
});

// Route mounts
await app.register(registryRoutes);
await app.register(jobsRoutes);
await app.register(contractsRoutes);
await app.register(x402Routes);
await app.register(spendRoutes);
await app.register(telemetryRoutes);
await app.register(negotiationRoutes);
await app.register(authRoutes);
await app.register(llmRoutes);
await app.register(capabilityRoutes);
await app.register(walletsRoutes);

// Forward every Claude call into the WS bus AND aggregate per-agent spend.
setClaudeLogSink((log) => {
  store.recordLlmSpend(log.costUsd, log.agentUri as `agent://${string}.local` | undefined);
  bus.publish({
    type: "llm.cost",
    agentUri: log.agentUri as `agent://${string}.local` | undefined,
    model: log.model,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    cacheReadTokens: log.cacheReadTokens,
    cacheWriteTokens: log.cacheWriteTokens,
    costUsd: log.costUsd,
    latencyMs: log.latencyMs,
    promptHash: log.promptHash,
    ts: log.ts,
  });
});

// 1Hz heartbeat (kept — useful for dashboard connection liveness)
setInterval(() => {
  bus.publish({ type: "heartbeat", ts: Date.now() });
}, 1000);

// 1Hz metrics
startMetricsTick();

// 2s deadline sweeper — refunds escrow, tanks reputation on timeout.
startDeadlineSweeper({ logger: app.log });

app.listen({ port: PORT, host: "0.0.0.0" }).then(async () => {
  // Boot smoke — exercise the happy path end-to-end before serving real
  // traffic. Set BOOT_SMOKE=0 to skip (local dev with a hot reload loop
  // doesn't need it on every restart).
  if (process.env.BOOT_SMOKE !== "0") {
    const result = await runBootSmoke(app);
    if (!result.ok) {
      app.log.error(
        { result },
        `boot smoke FAILED at step "${result.error?.step}": ${result.error?.message}`,
      );
      try {
        await app.close();
      } catch {/* ignore */}
      process.exit(1);
    }
    app.log.info(
      { totalMs: result.totalMs, steps: result.steps },
      `boot smoke PASSED in ${result.totalMs}ms`,
    );
  }
  app.log.info(`coordinator listening on :${PORT} (ws at /ws)`);
});
