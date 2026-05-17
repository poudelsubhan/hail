import { store } from "./store.js";
import { bus } from "./bus.js";
import { dao } from "./db/index.js";
import { wallet } from "./wallet.js";
import { recordOutcome } from "./metrics.js";

const REPUTATION_DELTA_TIMEOUT = -0.1;
const TICK_MS = 2_000;

/**
 * Scan live contracts every 2s; any that are still in `contracted` state past
 * their soft deadline (accepted + 2x etaSec) get marked timed_out. This is what
 * gives "bidder accepts work but ghosts" a consequence: refund the poster,
 * tank the bidder's reputation, and persist the outcome.
 */
export function startDeadlineSweeper(opts: { logger?: { info: (...a: unknown[]) => void } } = {}) {
  const tick = () => {
    const now = Date.now();
    for (const [contractId, contract] of store.contracts) {
      const meta = store.contractMeta.get(contractId);
      if (!meta) continue;
      if (meta.escrowReleased) continue;
      const job = store.jobs.get(contract.jobId);
      if (!job) continue;
      if (job.state !== "contracted") continue;

      const ageMs = now - meta.acceptedAt;
      const deadlineMs = meta.etaSec * 2 * 1000;
      if (ageMs < deadlineMs) continue;

      // Time out. Refund escrow → poster agent, tank bidder rep, persist outcome.
      wallet.credit(meta.posterWalletId, meta.escrowUsd, `refund:${contractId}:timeout`);
      meta.escrowReleased = true;
      store.bumpReputation(contract.bidderUri, REPUTATION_DELTA_TIMEOUT);
      store.jobs.set(job.jobId, { ...job, state: "failed" });
      store.jobOutcome.set(job.jobId, false);
      store.jobCompletedAt.set(job.jobId, now);
      recordOutcome(job.jobId, false);

      dao.insertCompletedContract({
        contract_id: contractId,
        job_id: contract.jobId,
        poster_uri: contract.posterUri,
        bidder_uri: contract.bidderUri,
        price_usd: contract.priceUsd,
        state: "timed_out",
        ts: now,
      });

      bus.publish({
        type: "contract.timed_out",
        contractId,
        jobId: contract.jobId,
        bidderUri: contract.bidderUri,
        ageMs,
        ts: now,
      });
      bus.publish({
        type: "job.completed",
        jobId: contract.jobId,
        success: false,
        latencyMs: now - (store.jobPostedAt.get(contract.jobId) ?? now),
        ts: now,
      });
      opts.logger?.info({ contractId, bidderUri: contract.bidderUri, ageMs }, "contract timed out");
    }
  };
  return setInterval(tick, TICK_MS);
}
