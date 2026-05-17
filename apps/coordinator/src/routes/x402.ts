import type { FastifyInstance } from "fastify";
import { X402SettleReq } from "@ac/contracts";
import { x402 } from "../x402-instance.js";
import { store } from "../store.js";
import { bus } from "../bus.js";

export async function x402Routes(app: FastifyInstance) {
  // POST /x402/settle — poster pays, gets HMAC-signed proof back.
  // v2: on success we also push `work.assigned` to the bidder's authenticated
  // WS so the bidder can start work without needing an inbound HTTP path.
  app.post("/x402/settle", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = X402SettleReq.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const r = x402.settle(parsed.data);
    if (!r.ok) return reply.code(409).send({ error: r.reason });

    const contract = store.contracts.get(r.contractId);
    const meta = store.contractMeta.get(r.contractId);
    const job = contract ? store.jobs.get(contract.jobId) : undefined;
    if (!contract || !meta || !job) {
      // Settled the nonce but contract is gone — degrade gracefully; the
      // poster still gets the proof so it can drive deliver out-of-band.
      return { paymentProof: r.paymentProof };
    }

    // Stash the proof so the sweeper / deliver path can audit if needed.
    meta.paymentProof = r.paymentProof;

    // Broadcast work.assigned. The bidder's SDK filters on `bidderUri ===
    // self.uri`, so only the winning agent acts; the dashboard ticker can
    // surface the moment ("the bidder was told to do the thing") for the
    // audience. Payment proof is single-use + verified server-side, so
    // broadcasting it can't be redeemed by an unauthorized caller (deliver
    // requires owning the bidder URI).
    const deadlineMs = meta.acceptedAt + meta.etaSec * 2 * 1000;
    bus.publish({
      type: "work.assigned",
      contractId: r.contractId,
      jobId: contract.jobId,
      bidderUri: contract.bidderUri,
      capability: job.capability,
      brief: job.brief,
      paymentProof: r.paymentProof,
      deadlineMs,
      ts: Date.now(),
    });
    req.log.info({ contractId: r.contractId, bidderUri: contract.bidderUri }, "work.assigned");

    return { paymentProof: r.paymentProof };
  });
}
