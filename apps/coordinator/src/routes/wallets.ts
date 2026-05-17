import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dao, userWalletId } from "../db/index.js";
import { wallet, InsufficientFundsError, WalletNotFoundError } from "../wallet.js";

const FundReq = z.object({
  fromUsd: z.number().positive(),
});

export async function walletsRoutes(app: FastifyInstance) {
  // GET /wallets — public read-only view, used by the dashboard WalletStrip.
  // Returns id / agentUri / balance only — no owner identity. Phase 2's
  // /admin endpoints expose the host-only superset (with owner info).
  app.get("/wallets", async () => {
    return {
      wallets: dao.listAllWallets().map((w) => ({
        id: w.id,
        agentUri: w.agent_uri,
        balanceUsd: w.balance_usd,
        createdAt: w.created_at,
      })),
    };
  });

  // GET /wallets/mine — caller's own wallets.
  app.get("/wallets/mine", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    return {
      wallets: dao.walletsForUser(req.user.id).map((w) => ({
        id: w.id,
        agentUri: w.agent_uri,
        balanceUsd: w.balance_usd,
      })),
    };
  });

  // POST /wallets/:agentWalletId/fund — move money from user-default to an
  // agent wallet the caller owns. The demo-day "sprinkle some balance on this
  // participant's agent" button.
  app.post("/wallets/:id/fund", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    const parsed = FundReq.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const target = dao.findWallet(id);
    if (!target) return reply.code(404).send({ error: "wallet_not_found" });
    if (target.owner_user_id !== req.user.id) {
      return reply.code(403).send({ error: "not_owner_of_wallet" });
    }
    if (target.agent_uri === null) {
      return reply.code(400).send({ error: "cannot_fund_user_default" });
    }
    try {
      const { fromBalance, toBalance } = wallet.transfer(
        userWalletId(req.user.id),
        id,
        parsed.data.fromUsd,
        `fund:${id}`,
      );
      return {
        userBalanceUsd: fromBalance,
        agentBalanceUsd: toBalance,
      };
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        return reply.code(402).send({
          error: "insufficient_balance",
          haveUsd: e.have,
          needUsd: e.need,
        });
      }
      if (e instanceof WalletNotFoundError) {
        return reply.code(404).send({ error: "wallet_not_found", walletId: e.walletId });
      }
      throw e;
    }
  });
}
