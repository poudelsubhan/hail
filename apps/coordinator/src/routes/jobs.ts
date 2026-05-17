import type { FastifyInstance } from "fastify";
import {
  PostJobReq,
  PlaceBidReq,
  AcceptBidReq,
  X402_HEADER,
} from "@ac/contracts";
import { store, newId } from "../store.js";
import { bus } from "../bus.js";
import { x402 } from "../x402-instance.js";
import { recordNegotiationLatency } from "../metrics.js";
import { dao, agentWalletIdFromUri } from "../db/index.js";
import { wallet, InsufficientFundsError } from "../wallet.js";

export async function jobsRoutes(app: FastifyInstance) {
  // POST /jobs — open a new job
  app.post("/jobs", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = PostJobReq.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { posterUri, capability, brief, maxPriceUsd } = parsed.data;
    if (!store.agents.has(posterUri)) {
      return reply.code(404).send({ error: "poster_not_registered" });
    }
    // Caller must own the poster URI.
    const owner = dao.findAgentOwner(posterUri);
    if (!owner || owner.owner_user_id !== req.user.id) {
      return reply.code(403).send({ error: "not_owner_of_poster_uri" });
    }
    // The poster *agent*'s wallet must be solvent enough to back its own
    // job. If their agent is short, they can top it up via POST /wallets/.../fund.
    const posterWalletId = agentWalletIdFromUri(posterUri);
    const balance = wallet.getBalance(posterWalletId);
    if (balance < maxPriceUsd) {
      return reply.code(402).send({
        error: "insufficient_balance",
        walletId: posterWalletId,
        balanceUsd: balance,
        needUsd: maxPriceUsd,
      });
    }
    const jobId = newId("job");
    const now = Date.now();
    store.jobs.set(jobId, {
      jobId,
      posterUri,
      capability,
      brief,
      maxPriceUsd,
      state: "open",
      createdAt: now,
    });
    store.jobPostedAt.set(jobId, now);
    store.bidsByJob.set(jobId, []);
    store.recordPostedJob(jobId, capability, brief, now);
    bus.publish({
      type: "job.posted",
      jobId,
      posterUri,
      capability,
      brief,
      maxPriceUsd,
      ts: now,
    });
    return { jobId };
  });

  // GET /jobs/:id — inspect
  app.get("/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.jobs.get(id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    const bidIds = store.bidsByJob.get(id) ?? [];
    const bids = bidIds.map((bid) => store.bids.get(bid)!).filter(Boolean);
    const result = store.jobResults.get(id);
    const completedAt = store.jobCompletedAt.get(id);
    return { job, bids, result, completedAt };
  });

  // POST /jobs/:id/bid — place a bid
  app.post("/jobs/:id/bid", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    const job = store.jobs.get(id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    if (job.state !== "open" && job.state !== "bidding") {
      return reply.code(409).send({ error: `job_state_${job.state}` });
    }
    const parsed = PlaceBidReq.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { bidderUri, priceUsd, etaSec, note } = parsed.data;
    if (!store.agents.has(bidderUri)) {
      return reply.code(404).send({ error: "bidder_not_registered" });
    }
    const bidderOwner = dao.findAgentOwner(bidderUri);
    if (!bidderOwner || bidderOwner.owner_user_id !== req.user.id) {
      return reply.code(403).send({ error: "not_owner_of_bidder_uri" });
    }
    if (priceUsd > job.maxPriceUsd) {
      return reply.code(409).send({ error: "over_max_price" });
    }
    const bidId = newId("bid");
    const now = Date.now();
    store.bids.set(bidId, {
      bidId,
      jobId: id,
      bidderUri,
      priceUsd,
      etaSec,
      note,
      createdAt: now,
    });
    store.bidsByJob.get(id)!.push(bidId);

    if (job.state === "open") {
      store.jobs.set(id, { ...job, state: "bidding" });
    }

    bus.publish({
      type: "bid.placed",
      jobId: id,
      bidId,
      bidderUri,
      priceUsd,
      etaSec,
      note,
      ts: now,
    });
    return { bidId };
  });

  // POST /jobs/:id/accept — accept a bid → contract + 402 challenge
  app.post("/jobs/:id/accept", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    const job = store.jobs.get(id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    if (job.state !== "bidding") {
      return reply.code(409).send({ error: `job_state_${job.state}` });
    }
    const posterOwner = dao.findAgentOwner(job.posterUri);
    if (!posterOwner || posterOwner.owner_user_id !== req.user.id) {
      return reply.code(403).send({ error: "not_owner_of_poster_uri" });
    }
    const parsed = AcceptBidReq.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const bid = store.bids.get(parsed.data.bidId);
    if (!bid || bid.jobId !== id) {
      return reply.code(404).send({ error: "bid_not_found" });
    }
    const bidderOwner = dao.findAgentOwner(bid.bidderUri);
    if (!bidderOwner) {
      return reply.code(409).send({ error: "bidder_owner_unknown" });
    }

    // Escrow the bid price from the poster *agent*'s wallet. This is what
    // gives the marketplace teeth — bad agents and timeouts cost real (mock) money.
    const posterWalletId = agentWalletIdFromUri(job.posterUri);
    const bidderWalletId = agentWalletIdFromUri(bid.bidderUri);
    try {
      wallet.debit(posterWalletId, bid.priceUsd, `escrow:${id}`);
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        return reply.code(402).send({
          error: "insufficient_balance",
          walletId: posterWalletId,
          haveUsd: e.have,
          needUsd: e.need,
        });
      }
      throw e;
    }

    const contractId = newId("con");
    const now = Date.now();
    store.contracts.set(contractId, {
      contractId,
      jobId: id,
      posterUri: job.posterUri,
      bidderUri: bid.bidderUri,
      priceUsd: bid.priceUsd,
      ts: now,
    });
    store.contractMeta.set(contractId, {
      etaSec: bid.etaSec,
      posterUserId: req.user.id,
      bidderUserId: bidderOwner.owner_user_id,
      posterWalletId,
      bidderWalletId,
      acceptedAt: now,
      escrowUsd: bid.priceUsd,
      escrowReleased: false,
    });
    store.jobs.set(id, { ...job, state: "contracted" });
    store.jobContractedAt.set(id, now);
    recordNegotiationLatency(id);

    bus.publish({
      type: "contract.signed",
      contractId,
      jobId: id,
      parties: [job.posterUri, bid.bidderUri],
      priceUsd: bid.priceUsd,
      ts: now,
    });

    const challenge = x402.issueChallenge({
      contractId,
      amountUsd: bid.priceUsd,
      posterUri: job.posterUri,
      bidderUri: bid.bidderUri,
      fromWalletId: posterWalletId,
      toWalletId: bidderWalletId,
    });

    // Return HTTP 402 in the x402 shape; body carries contractId for client convenience.
    return reply
      .code(402)
      .header(
        X402_HEADER,
        JSON.stringify({
          amountUsd: challenge.amountUsd,
          settleUrl: challenge.settleUrl,
          nonce: challenge.nonce,
        }),
      )
      .send({
        contractId,
        challenge,
      });
  });
}
