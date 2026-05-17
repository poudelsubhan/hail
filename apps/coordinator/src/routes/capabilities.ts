import type { FastifyInstance } from "fastify";
import { store } from "../store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /capabilities — what the marketplace knows how to do right now.
 * Aggregates from the live agent registry + a 24h ring of posted jobs so
 * newcomers can see what's hot and what's underserved.
 */
export async function capabilityRoutes(app: FastifyInstance) {
  app.get("/capabilities", async () => {
    const now = Date.now();
    const cutoff = now - DAY_MS;

    const tagInfo = new Map<
      string,
      {
        tag: string;
        agentUris: Set<string>;
        jobsLast24h: number;
        lastJobTs: number;
        sampleBriefs: string[];
      }
    >();

    for (const agent of store.agents.values()) {
      for (const cap of agent.capabilities) {
        let row = tagInfo.get(cap);
        if (!row) {
          row = { tag: cap, agentUris: new Set(), jobsLast24h: 0, lastJobTs: 0, sampleBriefs: [] };
          tagInfo.set(cap, row);
        }
        row.agentUris.add(agent.uri);
      }
    }

    for (const j of store.recentJobs) {
      if (j.ts < cutoff) continue;
      let row = tagInfo.get(j.capability);
      if (!row) {
        row = { tag: j.capability, agentUris: new Set(), jobsLast24h: 0, lastJobTs: 0, sampleBriefs: [] };
        tagInfo.set(j.capability, row);
      }
      row.jobsLast24h += 1;
      if (j.ts > row.lastJobTs) row.lastJobTs = j.ts;
      if (row.sampleBriefs.length < 3) {
        const brief = j.brief.length > 120 ? j.brief.slice(0, 117) + "…" : j.brief;
        row.sampleBriefs.push(brief);
      }
    }

    const capabilities = Array.from(tagInfo.values())
      .map((r) => ({
        tag: r.tag,
        agentCount: r.agentUris.size,
        agents: Array.from(r.agentUris),
        jobsLast24h: r.jobsLast24h,
        lastJobTs: r.lastJobTs,
        sampleBriefs: r.sampleBriefs,
      }))
      .sort((a, b) => {
        if (b.jobsLast24h !== a.jobsLast24h) return b.jobsLast24h - a.jobsLast24h;
        return b.agentCount - a.agentCount;
      });

    return { capabilities, ts: now };
  });
}
