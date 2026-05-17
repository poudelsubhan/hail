import type { FastifyInstance } from "fastify";
import { store } from "../store.js";

/**
 * Dashboard-facing spend rollups. The WS bus carries the events that drive
 * these totals in real time; this REST view is the source of truth on
 * reconnect (since events are not replayed).
 */
export async function spendRoutes(app: FastifyInstance) {
  app.get("/spend/total", async () => ({
    totalSpendUsd: store.totalSpendUsd,
    llmSpendUsd: store.llmSpendTotal,
    receipts: store.receipts.size,
    ts: Date.now(),
  }));

  app.get("/spend/per-agent", async () => {
    const rows: { agentUri: string; earnedUsd: number; llmSpendUsd: number; reputation: number }[] = [];
    for (const agent of store.agents.values()) {
      rows.push({
        agentUri: agent.uri,
        earnedUsd: store.spendByAgent.get(agent.uri) ?? 0,
        llmSpendUsd: store.llmSpendByAgent.get(agent.uri) ?? 0,
        reputation: agent.reputation,
      });
    }
    rows.sort((a, b) => b.earnedUsd - a.earnedUsd);
    return { agents: rows };
  });

  app.get("/spend/per-capability", async () => {
    const rows: { capability: string; spendUsd: number }[] = [];
    for (const [capability, spendUsd] of store.spendByCapability) {
      rows.push({ capability, spendUsd });
    }
    rows.sort((a, b) => b.spendUsd - a.spendUsd);
    return { capabilities: rows };
  });
}
