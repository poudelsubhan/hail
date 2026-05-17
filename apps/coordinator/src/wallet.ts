import { dao, userWalletId, type WalletRow } from "./db/index.js";
import { bus } from "./bus.js";
import type { AgentUri } from "@ac/contracts";

export class InsufficientFundsError extends Error {
  constructor(
    public readonly walletId: string,
    public readonly need: number,
    public readonly have: number,
  ) {
    super(`insufficient_funds: wallet=${walletId} need=${need.toFixed(2)} have=${have.toFixed(2)}`);
  }
}

export class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super(`wallet_not_found: ${walletId}`);
  }
}

export type LedgerEntry = {
  ts: number;
  walletId: string;
  deltaUsd: number;
  reason: string;
  balanceAfter: number;
};

/**
 * Short ring buffer of recent balance changes. Powers a dashboard panel and
 * lets us see "why did this wallet just go red" without trawling SQLite.
 */
const ledger: LedgerEntry[] = [];
const LEDGER_MAX = 200;

function append(entry: LedgerEntry) {
  ledger.push(entry);
  if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX);
}

/** User-default wallets mirror to users.balance_usd so v2 reads stay coherent. */
function mirrorIfUserDefault(row: WalletRow, newBalance: number) {
  if (row.agent_uri === null) {
    dao.setBalance(row.owner_user_id, newBalance);
  }
}

function emitChanged(row: WalletRow, delta: number, balance: number, reason: string) {
  bus.publish({
    type: "wallet.changed",
    walletId: row.id,
    agentUri: (row.agent_uri ?? undefined) as AgentUri | undefined,
    balanceUsd: balance,
    deltaUsd: delta,
    reason,
    ts: Date.now(),
  });
}

export const wallet = {
  getBalance(walletId: string): number {
    const row = dao.findWallet(walletId);
    if (!row) throw new WalletNotFoundError(walletId);
    return row.balance_usd;
  },

  /** Returns the wallet row, including `balance_usd`. */
  get(walletId: string): WalletRow {
    const row = dao.findWallet(walletId);
    if (!row) throw new WalletNotFoundError(walletId);
    return row;
  },

  debit(walletId: string, amountUsd: number, reason: string): number {
    if (amountUsd < 0) throw new Error("amount_must_be_positive");
    const { row, next } = dao.tx(() => {
      const r = dao.findWallet(walletId);
      if (!r) throw new WalletNotFoundError(walletId);
      if (r.balance_usd < amountUsd) {
        throw new InsufficientFundsError(walletId, amountUsd, r.balance_usd);
      }
      const n = Number((r.balance_usd - amountUsd).toFixed(4));
      dao.setWalletBalance(walletId, n);
      mirrorIfUserDefault(r, n);
      return { row: r, next: n };
    });
    append({ ts: Date.now(), walletId, deltaUsd: -amountUsd, reason, balanceAfter: next });
    emitChanged(row, -amountUsd, next, reason);
    return next;
  },

  credit(walletId: string, amountUsd: number, reason: string): number {
    if (amountUsd < 0) throw new Error("amount_must_be_positive");
    const { row, next } = dao.tx(() => {
      const r = dao.findWallet(walletId);
      if (!r) throw new WalletNotFoundError(walletId);
      const n = Number((r.balance_usd + amountUsd).toFixed(4));
      dao.setWalletBalance(walletId, n);
      mirrorIfUserDefault(r, n);
      return { row: r, next: n };
    });
    append({ ts: Date.now(), walletId, deltaUsd: amountUsd, reason, balanceAfter: next });
    emitChanged(row, amountUsd, next, reason);
    return next;
  },

  /** Atomic transfer between two wallets. Both events fire after commit. */
  transfer(fromId: string, toId: string, amountUsd: number, reason: string): {
    fromBalance: number;
    toBalance: number;
  } {
    if (amountUsd < 0) throw new Error("amount_must_be_positive");
    const out = dao.tx(() => {
      const from = dao.findWallet(fromId);
      const to = dao.findWallet(toId);
      if (!from) throw new WalletNotFoundError(fromId);
      if (!to) throw new WalletNotFoundError(toId);
      if (from.balance_usd < amountUsd) {
        throw new InsufficientFundsError(fromId, amountUsd, from.balance_usd);
      }
      const fromNext = Number((from.balance_usd - amountUsd).toFixed(4));
      const toNext = Number((to.balance_usd + amountUsd).toFixed(4));
      dao.setWalletBalance(fromId, fromNext);
      dao.setWalletBalance(toId, toNext);
      mirrorIfUserDefault(from, fromNext);
      mirrorIfUserDefault(to, toNext);
      return { from, to, fromNext, toNext };
    });
    append({ ts: Date.now(), walletId: fromId, deltaUsd: -amountUsd, reason, balanceAfter: out.fromNext });
    append({ ts: Date.now(), walletId: toId, deltaUsd: amountUsd, reason, balanceAfter: out.toNext });
    emitChanged(out.from, -amountUsd, out.fromNext, reason);
    emitChanged(out.to, amountUsd, out.toNext, reason);
    return { fromBalance: out.fromNext, toBalance: out.toNext };
  },

  /** v2 compat shim — resolves to the user-default wallet. */
  userDebit(userId: string, amountUsd: number, reason: string): number {
    return wallet.debit(userWalletId(userId), amountUsd, reason);
  },
  userCredit(userId: string, amountUsd: number, reason: string): number {
    return wallet.credit(userWalletId(userId), amountUsd, reason);
  },
  userBalance(userId: string): number {
    return wallet.getBalance(userWalletId(userId));
  },

  recentLedger(): LedgerEntry[] {
    return ledger.slice(-50);
  },
};
