import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentUri } from "@ac/contracts";

/**
 * x402-shaped payment mock. Lives in its own package so tests can pound on it
 * in isolation and the coordinator imports it like any other library.
 *
 * Shape only — no chain, no real money. HTTP 402 + nonce + HMAC-signed proof
 * is enough for the demo to flatter the x402 thesis.
 */

export interface X402Config {
  /** HMAC secret. Required in prod-shaped runs; defaults to dev secret only when explicit. */
  secret: string;
  /** Nonce TTL in ms. Default 5 minutes. */
  nonceTtlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface PendingChallenge {
  contractId: string;
  amountUsd: number;
  posterUri: AgentUri;
  bidderUri: AgentUri;
  fromWalletId?: string;
  toWalletId?: string;
  expiresAt: number;
}

export interface IssuedChallenge {
  nonce: string;
  amountUsd: number;
  settleUrl: string;
}

export type SettleResult =
  | { ok: true; paymentProof: string; contractId: string; amountUsd: number }
  | { ok: false; reason: SettleErrorReason };

export type SettleErrorReason =
  | "unknown_nonce"
  | "expired_nonce"
  | "amount_mismatch"
  | "wrong_payer";

export interface ProofPayload {
  contractId: string;
  amountUsd: number;
  nonce: string;
  from: AgentUri;
  ts: number;
  fromWalletId?: string;
  toWalletId?: string;
}

export type VerifyResult =
  | { ok: true; payload: ProofPayload }
  | { ok: false; reason: VerifyErrorReason };

export type VerifyErrorReason =
  | "malformed_proof"
  | "bad_signature"
  | "malformed_payload"
  | "contract_mismatch"
  | "replayed_proof";

export class X402 {
  private pending = new Map<string, PendingChallenge>();
  /** contractId -> ts when a proof was first consumed. Prevents replay on deliver. */
  private consumedProofs = new Map<string, number>();
  private settleUrl: string;

  constructor(
    private cfg: X402Config,
    opts: { settleUrl?: string } = {},
  ) {
    this.settleUrl = opts.settleUrl ?? "/x402/settle";
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  /** Sweep expired nonces. O(n) — fine for demo scale. */
  private gcExpired() {
    const now = this.now();
    for (const [nonce, ch] of this.pending) {
      if (ch.expiresAt <= now) this.pending.delete(nonce);
    }
  }

  issueChallenge(opts: {
    contractId: string;
    amountUsd: number;
    posterUri: AgentUri;
    bidderUri: AgentUri;
    fromWalletId?: string;
    toWalletId?: string;
  }): IssuedChallenge {
    this.gcExpired();
    const nonce = randomBytes(16).toString("hex");
    const ttl = this.cfg.nonceTtlMs ?? 5 * 60_000;
    this.pending.set(nonce, {
      contractId: opts.contractId,
      amountUsd: opts.amountUsd,
      posterUri: opts.posterUri,
      bidderUri: opts.bidderUri,
      fromWalletId: opts.fromWalletId,
      toWalletId: opts.toWalletId,
      expiresAt: this.now() + ttl,
    });
    return {
      nonce,
      amountUsd: opts.amountUsd,
      settleUrl: this.settleUrl,
    };
  }

  settle(opts: {
    nonce: string;
    amountUsd: number;
    from: AgentUri;
  }): SettleResult {
    // Don't gcExpired() here — we want the explicit `expired_nonce` reason
    // when a stale nonce is presented, not the less-informative
    // `unknown_nonce`. GC runs on issueChallenge() + pendingCount() instead.
    const ch = this.pending.get(opts.nonce);
    if (!ch) return { ok: false, reason: "unknown_nonce" };
    if (ch.expiresAt <= this.now()) {
      this.pending.delete(opts.nonce);
      return { ok: false, reason: "expired_nonce" };
    }
    if (Math.abs(ch.amountUsd - opts.amountUsd) > 1e-9) {
      return { ok: false, reason: "amount_mismatch" };
    }
    if (ch.posterUri !== opts.from) {
      return { ok: false, reason: "wrong_payer" };
    }
    // Single-use: consume the nonce now so a settle can't be replayed.
    this.pending.delete(opts.nonce);

    const payload: ProofPayload = {
      contractId: ch.contractId,
      amountUsd: ch.amountUsd,
      nonce: opts.nonce,
      from: opts.from,
      ts: this.now(),
      fromWalletId: ch.fromWalletId,
      toWalletId: ch.toWalletId,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.cfg.secret)
      .update(body)
      .digest("base64url");
    return {
      ok: true,
      paymentProof: `${body}.${sig}`,
      contractId: ch.contractId,
      amountUsd: ch.amountUsd,
    };
  }

  /**
   * Verify a payment proof against the expected contractId. Single-use:
   * subsequent calls with the same proof return `replayed_proof`. This stops
   * a bidder from delivering twice on one payment.
   */
  verifyPaymentProof(proof: string, expectedContractId: string): VerifyResult {
    const parts = proof.split(".");
    if (parts.length !== 2) return { ok: false, reason: "malformed_proof" };
    const [body, sig] = parts as [string, string];
    if (!body || !sig) return { ok: false, reason: "malformed_proof" };

    const expectedSig = createHmac("sha256", this.cfg.secret)
      .update(body)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad_signature" };
    }
    let payload: ProofPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString());
    } catch {
      return { ok: false, reason: "malformed_payload" };
    }
    if (payload.contractId !== expectedContractId) {
      return { ok: false, reason: "contract_mismatch" };
    }
    if (this.consumedProofs.has(expectedContractId)) {
      return { ok: false, reason: "replayed_proof" };
    }
    this.consumedProofs.set(expectedContractId, this.now());
    return { ok: true, payload };
  }

  /** Test/admin helper — number of outstanding (unconsumed) nonces. */
  pendingCount(): number {
    this.gcExpired();
    return this.pending.size;
  }
}
