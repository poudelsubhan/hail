import { test } from "node:test";
import assert from "node:assert/strict";
import { X402 } from "./index.js";

const POSTER = "agent://poster.local" as const;
const BIDDER = "agent://bidder.local" as const;
const CID = "con_abc";

function fresh(opts: { ttlMs?: number; now?: () => number } = {}) {
  return new X402({
    secret: "test-secret",
    nonceTtlMs: opts.ttlMs ?? 5 * 60_000,
    now: opts.now,
  });
}

test("happy path: issue → settle → verify", () => {
  const x = fresh();
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04,
    posterUri: POSTER, bidderUri: BIDDER,
  });
  const s = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: POSTER });
  assert.equal(s.ok, true);
  if (!s.ok) throw new Error();
  const v = x.verifyPaymentProof(s.paymentProof, CID);
  assert.equal(v.ok, true);
  if (!v.ok) throw new Error();
  assert.equal(v.payload.contractId, CID);
  assert.equal(v.payload.amountUsd, 0.04);
});

test("settle rejects unknown nonce", () => {
  const x = fresh();
  const r = x.settle({ nonce: "deadbeef", amountUsd: 0.04, from: POSTER });
  assert.deepEqual(r, { ok: false, reason: "unknown_nonce" });
});

test("settle rejects expired nonce", () => {
  let t = 1_000_000;
  const x = fresh({ ttlMs: 1000, now: () => t });
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04, posterUri: POSTER, bidderUri: BIDDER,
  });
  t += 1500; // past TTL
  const r = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: POSTER });
  assert.deepEqual(r, { ok: false, reason: "expired_nonce" });
});

test("settle rejects amount mismatch", () => {
  const x = fresh();
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04, posterUri: POSTER, bidderUri: BIDDER,
  });
  const r = x.settle({ nonce: ch.nonce, amountUsd: 0.05, from: POSTER });
  assert.deepEqual(r, { ok: false, reason: "amount_mismatch" });
});

test("settle rejects wrong payer", () => {
  const x = fresh();
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04, posterUri: POSTER, bidderUri: BIDDER,
  });
  const r = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: BIDDER });
  assert.deepEqual(r, { ok: false, reason: "wrong_payer" });
});

test("settle is single-use (replay-protected)", () => {
  const x = fresh();
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04, posterUri: POSTER, bidderUri: BIDDER,
  });
  const a = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: POSTER });
  const b = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: POSTER });
  assert.equal(a.ok, true);
  assert.deepEqual(b, { ok: false, reason: "unknown_nonce" });
});

test("verify rejects bad signature", () => {
  const x = fresh();
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04, posterUri: POSTER, bidderUri: BIDDER,
  });
  const s = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: POSTER });
  if (!s.ok) throw new Error();
  // Flip a byte in the signature.
  const [body] = s.paymentProof.split(".");
  const tampered = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const v = x.verifyPaymentProof(tampered, CID);
  assert.equal(v.ok, false);
});

test("verify rejects contract mismatch", () => {
  const x = fresh();
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04, posterUri: POSTER, bidderUri: BIDDER,
  });
  const s = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: POSTER });
  if (!s.ok) throw new Error();
  const v = x.verifyPaymentProof(s.paymentProof, "con_OTHER");
  assert.deepEqual(v, { ok: false, reason: "contract_mismatch" });
});

test("verify is single-use (deliver-replay protection)", () => {
  const x = fresh();
  const ch = x.issueChallenge({
    contractId: CID, amountUsd: 0.04, posterUri: POSTER, bidderUri: BIDDER,
  });
  const s = x.settle({ nonce: ch.nonce, amountUsd: 0.04, from: POSTER });
  if (!s.ok) throw new Error();
  const a = x.verifyPaymentProof(s.paymentProof, CID);
  const b = x.verifyPaymentProof(s.paymentProof, CID);
  assert.equal(a.ok, true);
  assert.deepEqual(b, { ok: false, reason: "replayed_proof" });
});

test("pendingCount tracks outstanding nonces", () => {
  const x = fresh();
  assert.equal(x.pendingCount(), 0);
  x.issueChallenge({ contractId: "c1", amountUsd: 1, posterUri: POSTER, bidderUri: BIDDER });
  x.issueChallenge({ contractId: "c2", amountUsd: 1, posterUri: POSTER, bidderUri: BIDDER });
  assert.equal(x.pendingCount(), 2);
});
