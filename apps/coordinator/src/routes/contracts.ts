import type { FastifyInstance } from "fastify";
import { DeliverReq } from "@ac/contracts";
import { store, newId } from "../store.js";
import { bus } from "../bus.js";
import { x402 } from "../x402-instance.js";
import { recordOutcome } from "../metrics.js";
import { dao } from "../db/index.js";
import { wallet } from "../wallet.js";

const REPUTATION_DELTA = { success: 0.05, failure: -0.1 };

export async function contractsRoutes(app: FastifyInstance) {
  // POST /contracts/:id/deliver — bidder hands in the work + proof of payment
  app.post("/contracts/:id/deliver", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    const contract = store.contracts.get(id);
    if (!contract) return reply.code(404).send({ error: "contract_not_found" });
    const meta = store.contractMeta.get(id);

    // Caller must own the bidder URI.
    const bidderOwner = dao.findAgentOwner(contract.bidderUri);
    if (!bidderOwner || bidderOwner.owner_user_id !== req.user.id) {
      return reply.code(403).send({ error: "not_owner_of_bidder_uri" });
    }

    const parsed = DeliverReq.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { result, paymentProof } = parsed.data;

    const v = x402.verifyPaymentProof(paymentProof, id);
    if (!v.ok) {
      store.bumpReputation(contract.bidderUri, REPUTATION_DELTA.failure);
      const job = store.jobs.get(contract.jobId);
      if (job) store.jobs.set(job.jobId, { ...job, state: "failed" });
      store.jobOutcome.set(contract.jobId, false);
      recordOutcome(contract.jobId, false);

      // Refund escrow to the poster *agent* — bidder failed to prove payment.
      if (meta && !meta.escrowReleased) {
        wallet.credit(meta.posterWalletId, meta.escrowUsd, `refund:${id}:proof_fail`);
        meta.escrowReleased = true;
      }
      // Persist the outcome so it survives coordinator restart.
      dao.insertCompletedContract({
        contract_id: id,
        job_id: contract.jobId,
        poster_uri: contract.posterUri,
        bidder_uri: contract.bidderUri,
        price_usd: contract.priceUsd,
        state: "failed",
        ts: Date.now(),
      });

      bus.publish({
        type: "job.completed",
        jobId: contract.jobId,
        success: false,
        latencyMs: Date.now() - (store.jobPostedAt.get(contract.jobId) ?? Date.now()),
        ts: Date.now(),
      });
      return reply.code(409).send({ error: `proof_${v.reason}` });
    }

    const job = store.jobs.get(contract.jobId);
    if (!job) return reply.code(404).send({ error: "job_gone" });
    if (job.state !== "contracted") {
      return reply.code(409).send({ error: `job_state_${job.state}` });
    }

    const now = Date.now();
    const receiptId = newId("rcp");
    store.receipts.set(receiptId, {
      receiptId,
      contractId: id,
      from: contract.posterUri,
      to: contract.bidderUri,
      amountUsd: contract.priceUsd,
      ts: now,
    });
    store.recordSpend({
      from: contract.posterUri,
      to: contract.bidderUri,
      capability: job.capability,
      amountUsd: contract.priceUsd,
    });

    // Release escrow → credit the bidder *agent*'s wallet. The poster's
    // agent was debited at accept time, so the round trip is balanced.
    if (meta && !meta.escrowReleased) {
      wallet.credit(meta.bidderWalletId, meta.escrowUsd, `settle:${id}`);
      meta.escrowReleased = true;
    }
    dao.insertCompletedContract({
      contract_id: id,
      job_id: contract.jobId,
      poster_uri: contract.posterUri,
      bidder_uri: contract.bidderUri,
      price_usd: contract.priceUsd,
      state: "settled",
      ts: now,
    });
    dao.insertReceipt({
      receipt_id: receiptId,
      contract_id: id,
      from_uri: contract.posterUri,
      to_uri: contract.bidderUri,
      amount_usd: contract.priceUsd,
      ts: now,
      from_wallet_id: meta?.posterWalletId ?? null,
      to_wallet_id: meta?.bidderWalletId ?? null,
    });

    bus.publish({
      type: "payment.settled",
      contractId: id,
      receiptId,
      priceUsd: contract.priceUsd,
      ts: now,
    });

    store.jobs.set(job.jobId, { ...job, state: "settled" });
    store.jobCompletedAt.set(job.jobId, now);
    store.jobOutcome.set(job.jobId, true);
    store.jobResults.set(job.jobId, result);
    store.bumpReputation(contract.bidderUri, REPUTATION_DELTA.success);
    recordOutcome(job.jobId, true);

    const postedAt = store.jobPostedAt.get(job.jobId) ?? now;
    bus.publish({
      type: "job.completed",
      jobId: job.jobId,
      success: true,
      latencyMs: now - postedAt,
      result,
      ts: now,
    });

    return { receiptId };
  });

  app.get("/contracts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = store.contracts.get(id);
    if (!c) return reply.code(404).send({ error: "not_found" });
    return c;
  });

  app.get("/receipts", async (req) => {
    const q = req.query as { since?: string };
    const since = q.since ? Number(q.since) : 0;
    const list = [];
    for (const r of store.receipts.values()) {
      if (r.ts >= since) list.push(r);
    }
    return { receipts: list };
  });
}
