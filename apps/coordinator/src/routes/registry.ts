import type { FastifyInstance } from "fastify";
import { RegisterReq, LookupRes, handleFromUri } from "@ac/contracts";
import { store } from "../store.js";
import { bus } from "../bus.js";
import { dao, agentWalletIdFromUri, userWalletId } from "../db/index.js";
import { wallet } from "../wallet.js";

const AGENT_STARTING_BALANCE_USD = Number(
  process.env.AC_AGENT_STARTING_BALANCE_USD ?? "1.00",
);

export async function registryRoutes(app: FastifyInstance) {
  app.post("/registry/register", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = RegisterReq.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { uri, url, capabilities, pubkey } = parsed.data;

    // Enforce that the URI handle matches the caller's user handle. This is
    // what stops alice from registering `agent://bob.helper`.
    const uriHandle = handleFromUri(uri);
    if (!uriHandle) {
      return reply.code(400).send({ error: "uri_handle_unparseable" });
    }
    if (uriHandle !== req.user.handle.toLowerCase()) {
      return reply.code(403).send({ error: "uri_handle_mismatch", expected: req.user.handle });
    }

    // Enforce ownership in agent_owners. Re-registering an existing URI is
    // fine, but only if you already own it (covers reboots).
    const existingOwner = dao.findAgentOwner(uri);
    if (existingOwner && existingOwner.owner_user_id !== req.user.id) {
      return reply.code(409).send({ error: "uri_owned_by_other_user" });
    }
    const isFirstRegister = !existingOwner;
    if (isFirstRegister) {
      dao.insertAgentOwner(uri, req.user.id, Date.now());
    }

    // Materialize the agent wallet idempotently. Funded once on first
    // register from the user-default wallet (if the user has enough), then
    // independent of user.balance_usd from then on.
    const agentWalletAlreadyExisted = !!dao.findWalletByAgent(uri);
    const agentWallet = dao.ensureWallet({
      id: agentWalletIdFromUri(uri),
      ownerUserId: req.user.id,
      agentUri: uri,
      initialBalance: 0,
    });
    if (isFirstRegister && !agentWalletAlreadyExisted && AGENT_STARTING_BALANCE_USD > 0) {
      const userBal = wallet.getBalance(userWalletId(req.user.id));
      const transfer = Math.min(AGENT_STARTING_BALANCE_USD, userBal);
      if (transfer > 0) {
        wallet.transfer(userWalletId(req.user.id), agentWallet.id, transfer, `seed:${uri}`);
      }
    }

    const existing = store.agents.get(uri);
    const agent = {
      uri,
      url,
      capabilities,
      pubkey,
      reputation: existing?.reputation ?? 0.5,
    };
    store.agents.set(uri, agent);
    bus.publish({
      type: "agent.registered",
      uri,
      capabilities,
      ts: Date.now(),
    });
    return { ok: true, agent };
  });

  app.get("/registry/lookup", async (req, reply) => {
    const q = req.query as { capability?: string };
    if (!q.capability) {
      return reply.code(400).send({ error: "capability required" });
    }
    const matches = [];
    for (const a of store.agents.values()) {
      if (a.capabilities.includes(q.capability)) matches.push(a);
    }
    const res: LookupRes = { agents: matches };
    return res;
  });

  app.get("/registry/agents", async () => ({
    agents: Array.from(store.agents.values()),
  }));
}
