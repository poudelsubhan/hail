"use client";

import { useEffect, useReducer, useRef } from "react";
import type { Agent, WsEvent } from "@ac/contracts";

const COORD_URL = process.env.NEXT_PUBLIC_COORD_URL ?? "http://localhost:8787";
const COORD_WS = process.env.NEXT_PUBLIC_COORD_WS ?? "ws://localhost:8787/ws";

const EVENT_BUFFER_SIZE = 200;

export interface DashboardState {
  connected: boolean;
  /** Latest metrics.tick snapshot. */
  metrics: {
    activeJobs: number;
    totalSpendUsd: number;
    p50ms: number;
    p95ms: number;
    successRate: number;
  };
  /** Registry — keyed by agent URI. */
  agents: Record<string, AgentView>;
  /** LLM spend per agent (cumulative). */
  llmSpend: Record<string, number>;
  /** Last seen ts per agent (for flash on activity). */
  lastSeen: Record<string, number>;
  /** Ring buffer of recent events, newest at index 0. */
  events: WsEvent[];
  /** Latest job.completed result that carries a URL (Coframe iframe). */
  preview: { url: string; title: string; jobId: string } | null;
  /** Number of completed jobs since boot, success or fail. */
  jobsCompleted: number;
  /** Bottom-line totals from REST hydration. */
  llmSpendTotal: number;
  receiptsCount: number;
  /** Ephemeral reputation delta chips — pop on job.completed, fade out by TTL. */
  repDeltas: { id: string; agentUri: string; delta: number; ts: number }[];
  /** v3: wallet balances keyed by walletId. Updated by wallet.changed events. */
  wallets: Record<string, WalletView>;
  /** v3: ephemeral wallet-delta chips — pop on wallet.changed, fade out. */
  walletDeltas: { id: string; walletId: string; delta: number; ts: number }[];
}

export interface WalletView {
  id: string;
  agentUri: string | null;
  balanceUsd: number;
  /** Last delta + ts for flash highlight. */
  lastDeltaUsd?: number;
  lastChangedTs?: number;
}

export interface AgentView extends Agent {
  earnedUsd?: number;
  llmSpendUsd?: number;
}

type Action =
  | { type: "connection"; connected: boolean }
  | { type: "ws-event"; evt: WsEvent }
  | { type: "hydrate"; agents: AgentView[]; total: { totalSpendUsd: number; llmSpendUsd: number; receipts: number } }
  | { type: "hydrate-wallets"; wallets: WalletView[] }
  | { type: "expire-rep-deltas"; before: number }
  | { type: "expire-wallet-deltas"; before: number };

const INITIAL: DashboardState = {
  connected: false,
  metrics: { activeJobs: 0, totalSpendUsd: 0, p50ms: 0, p95ms: 0, successRate: 1 },
  agents: {},
  llmSpend: {},
  lastSeen: {},
  events: [],
  preview: null,
  jobsCompleted: 0,
  llmSpendTotal: 0,
  receiptsCount: 0,
  repDeltas: [],
  wallets: {},
  walletDeltas: [],
};

function reducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "connection":
      return { ...state, connected: action.connected };
    case "hydrate": {
      const agents: Record<string, AgentView> = {};
      const llmSpend: Record<string, number> = { ...state.llmSpend };
      for (const a of action.agents) {
        agents[a.uri] = a;
        if (a.llmSpendUsd != null) llmSpend[a.uri] = a.llmSpendUsd;
      }
      return {
        ...state,
        agents: { ...state.agents, ...agents },
        llmSpend,
        llmSpendTotal: action.total.llmSpendUsd,
        receiptsCount: action.total.receipts,
      };
    }
    case "hydrate-wallets": {
      const wallets: Record<string, WalletView> = { ...state.wallets };
      for (const w of action.wallets) {
        const prev = wallets[w.id];
        wallets[w.id] = { ...w, lastDeltaUsd: prev?.lastDeltaUsd, lastChangedTs: prev?.lastChangedTs };
      }
      return { ...state, wallets };
    }
    case "expire-rep-deltas":
      return {
        ...state,
        repDeltas: state.repDeltas.filter((d) => d.ts > action.before),
      };
    case "expire-wallet-deltas":
      return {
        ...state,
        walletDeltas: state.walletDeltas.filter((d) => d.ts > action.before),
      };
    case "ws-event": {
      const evt = action.evt;
      // Update derived fields based on event type
      let next: DashboardState = state;

      if (
        evt.type !== "heartbeat" &&
        evt.type !== "metrics.tick" &&
        evt.type !== "wallet.changed"
      ) {
        const events = [evt, ...state.events].slice(0, EVENT_BUFFER_SIZE);
        next = { ...next, events };
      }

      switch (evt.type) {
        case "metrics.tick":
          next = {
            ...next,
            metrics: {
              activeJobs: evt.activeJobs,
              totalSpendUsd: evt.totalSpendUsd,
              p50ms: evt.p50ms,
              p95ms: evt.p95ms,
              successRate: evt.successRate,
            },
          };
          break;
        case "agent.registered": {
          const existing = state.agents[evt.uri];
          next = {
            ...next,
            agents: {
              ...next.agents,
              [evt.uri]: {
                uri: evt.uri,
                url: existing?.url ?? "",
                capabilities: evt.capabilities,
                pubkey: existing?.pubkey ?? "",
                reputation: existing?.reputation ?? 0.5,
              },
            },
            lastSeen: { ...next.lastSeen, [evt.uri]: evt.ts },
          };
          break;
        }
        case "bid.placed":
          next = {
            ...next,
            lastSeen: { ...next.lastSeen, [evt.bidderUri]: evt.ts },
          };
          break;
        case "contract.signed":
          next = {
            ...next,
            lastSeen: {
              ...next.lastSeen,
              [evt.parties[0]]: evt.ts,
              [evt.parties[1]]: evt.ts,
            },
          };
          break;
        case "job.completed": {
          const jobsCompleted = state.jobsCompleted + 1;
          let preview = state.preview;
          const result = evt.result as { url?: string; title?: string } | undefined;
          if (evt.success && result?.url) {
            preview = {
              url: result.url,
              title: result.title ?? "rendered",
              jobId: evt.jobId,
            };
          }
          // Floating reputation delta chip — find the winning bidder via the
          // most recent contract.signed for this job in the event ring.
          const signed = state.events.find(
            (e) => e.type === "contract.signed" && e.jobId === evt.jobId,
          );
          let repDeltas = next.repDeltas;
          if (signed && signed.type === "contract.signed") {
            const winner = signed.parties[1];
            const delta = evt.success ? 0.05 : -0.1;
            repDeltas = [
              ...next.repDeltas,
              { id: `${evt.jobId}-${evt.ts}`, agentUri: winner, delta, ts: evt.ts },
            ];
          }
          next = { ...next, jobsCompleted, preview, repDeltas };
          break;
        }
        case "payment.settled":
          // totalSpend comes from metrics.tick; nothing extra to do here.
          break;
        case "wallet.changed": {
          const prev = next.wallets[evt.walletId];
          const view: WalletView = {
            id: evt.walletId,
            agentUri: evt.agentUri ?? prev?.agentUri ?? null,
            balanceUsd: evt.balanceUsd,
            lastDeltaUsd: evt.deltaUsd,
            lastChangedTs: evt.ts,
          };
          next = {
            ...next,
            wallets: { ...next.wallets, [evt.walletId]: view },
            walletDeltas: [
              ...next.walletDeltas,
              { id: `${evt.walletId}-${evt.ts}`, walletId: evt.walletId, delta: evt.deltaUsd, ts: evt.ts },
            ],
          };
          break;
        }
        case "llm.cost": {
          if (evt.agentUri) {
            const cur = next.llmSpend[evt.agentUri] ?? 0;
            next = {
              ...next,
              llmSpend: { ...next.llmSpend, [evt.agentUri]: cur + evt.costUsd },
              llmSpendTotal: next.llmSpendTotal + evt.costUsd,
              lastSeen: { ...next.lastSeen, [evt.agentUri]: evt.ts },
            };
          } else {
            next = { ...next, llmSpendTotal: next.llmSpendTotal + evt.costUsd };
          }
          break;
        }
      }
      return next;
    }
    default:
      return state;
  }
}

export function useDashboard() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryMs = 250;

    const hydrate = async () => {
      try {
        const [regRes, totRes, spendRes, walRes] = await Promise.all([
          fetch(`${COORD_URL}/registry/agents`),
          fetch(`${COORD_URL}/spend/total`),
          fetch(`${COORD_URL}/spend/per-agent`),
          fetch(`${COORD_URL}/wallets`),
        ]);
        const { agents } = (await regRes.json()) as { agents: Agent[] };
        const total = (await totRes.json()) as {
          totalSpendUsd: number;
          llmSpendUsd: number;
          receipts: number;
        };
        const { agents: spendRows } = (await spendRes.json()) as {
          agents: { agentUri: string; earnedUsd: number; llmSpendUsd: number }[];
        };
        const { wallets } = (await walRes.json()) as {
          wallets: { id: string; agentUri: string | null; balanceUsd: number }[];
        };
        const byUri = new Map(spendRows.map((r) => [r.agentUri, r]));
        const enriched: AgentView[] = agents.map((a) => ({
          ...a,
          earnedUsd: byUri.get(a.uri)?.earnedUsd ?? 0,
          llmSpendUsd: byUri.get(a.uri)?.llmSpendUsd ?? 0,
        }));
        if (!cancelled) {
          dispatch({ type: "hydrate", agents: enriched, total });
          dispatch({
            type: "hydrate-wallets",
            wallets: wallets.map((w) => ({
              id: w.id,
              agentUri: w.agentUri,
              balanceUsd: w.balanceUsd,
            })),
          });
        }
      } catch {
        /* coordinator probably not up yet — WS reconnect will keep trying */
      }
    };

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(COORD_WS);
      wsRef.current = ws;
      ws.onopen = () => {
        retryMs = 250;
        dispatch({ type: "connection", connected: true });
        hydrate();
      };
      ws.onmessage = (e) => {
        let evt: WsEvent;
        try {
          evt = JSON.parse(e.data as string);
        } catch {
          return;
        }
        dispatch({ type: "ws-event", evt });
      };
      ws.onclose = () => {
        dispatch({ type: "connection", connected: false });
        if (cancelled) return;
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 5000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {/* ignore */}
      };
    };

    connect();

    // Sweep expired floating chips (2s TTL).
    const sweep = setInterval(() => {
      dispatch({ type: "expire-rep-deltas", before: Date.now() - 2000 });
      dispatch({ type: "expire-wallet-deltas", before: Date.now() - 2000 });
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(sweep);
      wsRef.current?.close();
    };
  }, []);

  return state;
}
