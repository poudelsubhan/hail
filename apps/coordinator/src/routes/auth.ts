import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dao, generateApiKey, generateInviteCode, nanoid, sha256, userWalletId } from "../db/index.js";

const SignupReq = z.object({
  inviteCode: z.string().min(4),
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/i, "handle must be url-safe slug"),
  email: z.string().email().optional(),
});

const InviteReq = z.object({
  note: z.string().max(120).optional(),
});

const STARTING_BALANCE_USD = Number(process.env.AC_STARTING_BALANCE_USD ?? "5.00");

export async function authRoutes(app: FastifyInstance) {
  // POST /invites — host issues a new invite code
  app.post("/invites", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    if (!req.user.is_host) return reply.code(403).send({ error: "host_only" });
    const parsed = InviteReq.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const code = generateInviteCode();
    dao.insertInvite({
      code,
      created_by: req.user.id,
      created_at: Date.now(),
      note: parsed.data.note ?? null,
    });
    const baseUrl = process.env.AC_PUBLIC_BASE_URL ?? `http://localhost:${process.env.COORDINATOR_PORT ?? 8787}`;
    return { code, url: `${baseUrl}/signup?invite=${encodeURIComponent(code)}` };
  });

  // GET /invites — host lists unused
  app.get("/invites", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    if (!req.user.is_host) return reply.code(403).send({ error: "host_only" });
    return { invites: dao.listUnusedInvites() };
  });

  // DELETE /invites/:code — host revokes
  app.delete("/invites/:code", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    if (!req.user.is_host) return reply.code(403).send({ error: "host_only" });
    const { code } = req.params as { code: string };
    const inv = dao.findInvite(code);
    if (!inv) return reply.code(404).send({ error: "invite_not_found" });
    if (inv.consumed_at) return reply.code(409).send({ error: "already_consumed" });
    dao.deleteInvite(code);
    return { ok: true };
  });

  // POST /signup — invitee redeems an invite, gets back an apiKey
  app.post("/signup", async (req, reply) => {
    const parsed = SignupReq.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { inviteCode, handle, email } = parsed.data;

    if (dao.findUserByHandle(handle)) {
      return reply.code(409).send({ error: "handle_taken" });
    }

    const apiKey = generateApiKey();
    try {
      dao.tx(() => {
        const inv = dao.findInvite(inviteCode);
        if (!inv) throw new Error("invite_not_found");
        if (inv.consumed_at) throw new Error("invite_consumed");
        const userId = `usr_${nanoid(6)}`;
        const now = Date.now();
        dao.insertUser({
          id: userId,
          handle,
          email: email ?? null,
          api_key_hash: sha256(apiKey),
          balance_usd: STARTING_BALANCE_USD,
          created_at: now,
          is_host: 0,
        });
        dao.ensureWallet({
          id: userWalletId(userId),
          ownerUserId: userId,
          agentUri: null,
          initialBalance: STARTING_BALANCE_USD,
        });
        const ok = dao.consumeInvite(inviteCode, userId, now);
        if (!ok) throw new Error("invite_consumed_race");
      });
    } catch (e: any) {
      const msg = e?.message ?? "signup_failed";
      const status =
        msg === "invite_not_found" ? 404 :
        msg === "invite_consumed" || msg === "invite_consumed_race" || msg === "handle_taken" ? 409 :
        500;
      return reply.code(status).send({ error: msg });
    }

    const user = dao.findUserByHandle(handle)!;
    return {
      apiKey,
      userId: user.id,
      handle: user.handle,
      balanceUsd: user.balance_usd,
    };
  });

  // GET /me — authed introspection
  app.get("/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const agents = dao.agentsForUser(req.user.id).map((r) => r.uri);
    const wallets = dao.walletsForUser(req.user.id);
    // v3: `balanceUsd` is the sum across all the user's wallets (user-default
    // + every agent wallet). This keeps v2 smoke assertions stable while
    // money actually moves on the per-agent wallets.
    const balanceUsd = dao.sumWalletsForUser(req.user.id);
    return {
      userId: req.user.id,
      handle: req.user.handle,
      balanceUsd,
      isHost: !!req.user.is_host,
      agents,
      wallets: wallets.map((w) => ({
        id: w.id,
        agentUri: w.agent_uri,
        balanceUsd: w.balance_usd,
      })),
    };
  });
}
