import type { FastifyInstance } from "fastify";
import { dao, generateInviteCode, nanoid } from "./db/index.js";
import { store } from "./store.js";

/**
 * End-to-end self-test that runs after the coordinator binds the port and
 * before the "listening" log line. If anything fails we exit(1) loudly —
 * Fly's health check rolls the deploy back instead of serving a broken
 * marketplace to the audience.
 *
 * The flow uses `app.inject()` so we don't depend on the network being up,
 * and goes through the real auth + route handlers (not direct dao calls)
 * so middleware regressions are caught.
 *
 * Bypasses the host-only POST /invites by inserting the invite via dao.
 * Everything else is HTTP-shaped.
 */
export interface BootSmokeResult {
  ok: boolean;
  totalMs: number;
  steps: { step: string; status: number; elapsedMs: number }[];
  error?: { step: string; message: string };
}

const HANDLE_PREFIX = "boot-smoke-"; // matches handle regex ^[a-z0-9][a-z0-9-]{1,30}$

export async function runBootSmoke(
  app: FastifyInstance,
): Promise<BootSmokeResult> {
  const t0 = Date.now();
  const steps: BootSmokeResult["steps"] = [];
  const log = app.log.child({ component: "boot-smoke" });

  // Generate a smoke user identity. Random suffix so concurrent boots (or
  // a previous failed cleanup) don't collide.
  const suffix = nanoid(3);
  const handle = `${HANDLE_PREFIX}${suffix}`;
  const inviteCode = generateInviteCode();
  const posterUri = `agent://${handle}.poster`;
  const bidderUri = `agent://${handle}.bidder`;
  let userId: string | undefined;

  async function step<T>(name: string, fn: () => Promise<{ status: number; body: T }>): Promise<T> {
    const t = Date.now();
    const r = await fn();
    const elapsedMs = Date.now() - t;
    steps.push({ step: name, status: r.status, elapsedMs });
    log.info({ step: name, status: r.status, elapsedMs }, `boot-smoke ${name}`);
    if (r.status < 200 || r.status >= 300) {
      throw new BootSmokeError(name, `unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
    }
    return r.body;
  }

  try {
    // 0. Seed invite directly (bypass host-only /invites — we don't have
    //    the host's apiKey in-process, only its hash).
    dao.insertInvite({
      code: inviteCode,
      created_by: null,
      created_at: Date.now(),
      note: "boot-smoke",
    });

    // 1. Sign up the smoke user. user-default wallet is created with $5.
    const signup = await step("signup", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/signup",
        payload: { inviteCode, handle },
      });
      return { status: r.statusCode, body: r.json() as { apiKey: string; userId: string } };
    });
    userId = signup.userId;
    const apiKey = signup.apiKey;
    const auth = { authorization: `Bearer ${apiKey}` };

    // 2. Register the poster agent — first register drains user-default into
    //    agent A's wallet (up to AC_AGENT_STARTING_BALANCE_USD).
    await step("register-poster", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/registry/register",
        headers: auth,
        payload: { uri: posterUri, url: "http://boot-smoke.invalid", capabilities: ["__smoke__"], pubkey: "pk_smoke" },
      });
      return { status: r.statusCode, body: r.json() };
    });

    // 3. Register the bidder agent — user-default is now $0 so this wallet
    //    starts at $0. That's fine: bidders don't need money to bid, only
    //    posters need to fund escrow.
    await step("register-bidder", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/registry/register",
        headers: auth,
        payload: { uri: bidderUri, url: "http://boot-smoke.invalid", capabilities: ["__smoke__"], pubkey: "pk_smoke" },
      });
      return { status: r.statusCode, body: r.json() };
    });

    // 4. Post a tiny job from the poster.
    const { jobId } = await step("post-job", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/jobs",
        headers: auth,
        payload: { posterUri, capability: "__smoke__", brief: "boot smoke", maxPriceUsd: 0.05 },
      });
      return { status: r.statusCode, body: r.json() as { jobId: string } };
    });

    // 5. Bid from the bidder. etaSec=30 so the deadline sweeper can't kill
    //    us if boot smoke shares a tick with normal traffic.
    const { bidId } = await step("place-bid", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/bid`,
        headers: auth,
        payload: { bidderUri, priceUsd: 0.05, etaSec: 30, note: "boot-smoke" },
      });
      return { status: r.statusCode, body: r.json() as { bidId: string } };
    });

    // 6. Accept the bid. Coord returns 402 + x402 challenge — that's the
    //    happy path, not an error.
    const accept = await step("accept", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/accept`,
        headers: auth,
        payload: { bidId },
      });
      if (r.statusCode !== 402) {
        return { status: r.statusCode, body: r.json() };
      }
      return {
        status: 200,
        body: r.json() as { contractId: string; challenge: { nonce: string; amountUsd: number } },
      };
    });
    const contractId = (accept as { contractId: string }).contractId;
    const challenge = (accept as { challenge: { nonce: string; amountUsd: number } }).challenge;

    // 7. Settle the x402 challenge to mint a payment proof.
    const { paymentProof } = await step("settle", async () => {
      const r = await app.inject({
        method: "POST",
        url: "/x402/settle",
        headers: auth,
        payload: { nonce: challenge.nonce, amountUsd: challenge.amountUsd, from: posterUri },
      });
      return { status: r.statusCode, body: r.json() as { paymentProof: string } };
    });

    // 8. Deliver with the payment proof. Bidder is credited; reputation
    //    nudges; receipt persists.
    await step("deliver", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/contracts/${contractId}/deliver`,
        headers: auth,
        payload: { result: { ok: true }, paymentProof },
      });
      return { status: r.statusCode, body: r.json() };
    });

    return { ok: true, totalMs: Date.now() - t0, steps };
  } catch (e: unknown) {
    const err = e instanceof BootSmokeError
      ? { step: e.step, message: e.message }
      : { step: "unknown", message: e instanceof Error ? e.message : String(e) };
    return { ok: false, totalMs: Date.now() - t0, steps, error: err };
  } finally {
    // Cleanup. Best-effort — never lets a cleanup error mask a real smoke
    // failure.
    try {
      store.agents.delete(posterUri as `agent://${string}`);
      store.agents.delete(bidderUri as `agent://${string}`);
      if (userId) dao.deleteUser(userId);
      else {
        // Signup failed; the invite row will still be sitting around. Drop it.
        dao.deleteInvite(inviteCode);
      }
    } catch (cleanupErr) {
      log.warn({ err: String(cleanupErr) }, "boot-smoke cleanup error (non-fatal)");
    }
  }
}

class BootSmokeError extends Error {
  constructor(public readonly step: string, message: string) {
    super(`[${step}] ${message}`);
  }
}
