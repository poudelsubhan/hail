import Database, { type Database as DatabaseType } from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = resolve(
  process.env.SQLITE_PATH ?? resolve(__dirname, "../../data/ac.db"),
);
mkdirSync(dirname(dbPath), { recursive: true });

export const db: DatabaseType = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaSql = readFileSync(resolve(__dirname, "./schema.sql"), "utf8");
db.exec(schemaSql);

// Tiny additive migration: receipts pre-v3 lacked from_wallet_id/to_wallet_id.
// CREATE IF NOT EXISTS is a no-op on existing tables, so do this explicitly.
{
  const cols = db.prepare("PRAGMA table_info(receipts)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("from_wallet_id")) db.exec("ALTER TABLE receipts ADD COLUMN from_wallet_id TEXT");
  if (!have.has("to_wallet_id")) db.exec("ALTER TABLE receipts ADD COLUMN to_wallet_id TEXT");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function nanoid(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

export function generateApiKey(): string {
  return `ak_${randomBytes(12).toString("hex")}`;
}

export function generateInviteCode(): string {
  return randomBytes(6).toString("hex");
}

export type UserRow = {
  id: string;
  handle: string;
  email: string | null;
  api_key_hash: string;
  balance_usd: number;
  created_at: number;
  is_host: number;
};

export type InviteRow = {
  code: string;
  created_by: string | null;
  created_at: number;
  consumed_at: number | null;
  consumed_by_user: string | null;
  note: string | null;
};

export type AgentOwnerRow = {
  uri: string;
  owner_user_id: string;
  created_at: number;
};

export type CompletedContractRow = {
  contract_id: string;
  job_id: string;
  poster_uri: string;
  bidder_uri: string;
  price_usd: number;
  state: "settled" | "failed" | "timed_out";
  ts: number;
};

export type ReceiptRow = {
  receipt_id: string;
  contract_id: string;
  from_uri: string;
  to_uri: string;
  amount_usd: number;
  ts: number;
  from_wallet_id?: string | null;
  to_wallet_id?: string | null;
};

export type WalletRow = {
  id: string;
  owner_user_id: string;
  agent_uri: string | null;
  balance_usd: number;
  created_at: number;
};

/** Deterministic wallet IDs — the human-readable form is part of the demo. */
export function userWalletId(userId: string): string {
  return `wlt_user_${userId}`;
}
/** `wlt_<handle>_<slug>` derived from `agent://<handle>.<slug>`. */
export function agentWalletIdFromUri(agentUri: string): string {
  const m = /^agent:\/\/([a-z0-9][a-z0-9-]{0,30})\.([a-z0-9][a-z0-9-]{0,30})/i.exec(agentUri);
  if (!m) throw new Error(`bad_agent_uri: ${agentUri}`);
  return `wlt_${m[1]!.toLowerCase()}_${m[2]!.toLowerCase()}`;
}

export type LlmCostRow = {
  id: number;
  user_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ts: number;
};

const stmts = {
  userByApiKeyHash: db.prepare<[string], UserRow>(
    "SELECT * FROM users WHERE api_key_hash = ?",
  ),
  userById: db.prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?"),
  userByHandle: db.prepare<[string], UserRow>(
    "SELECT * FROM users WHERE handle = ?",
  ),
  insertUser: db.prepare(
    `INSERT INTO users (id, handle, email, api_key_hash, balance_usd, created_at, is_host)
     VALUES (@id, @handle, @email, @api_key_hash, @balance_usd, @created_at, @is_host)`,
  ),
  countUsers: db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM users"),
  setBalance: db.prepare(
    "UPDATE users SET balance_usd = ? WHERE id = ?",
  ),
  getBalance: db.prepare<[string], { balance_usd: number }>(
    "SELECT balance_usd FROM users WHERE id = ?",
  ),
  inviteByCode: db.prepare<[string], InviteRow>(
    "SELECT * FROM invites WHERE code = ?",
  ),
  insertInvite: db.prepare(
    `INSERT INTO invites (code, created_by, created_at, consumed_at, consumed_by_user, note)
     VALUES (@code, @created_by, @created_at, NULL, NULL, @note)`,
  ),
  consumeInvite: db.prepare(
    `UPDATE invites SET consumed_at = ?, consumed_by_user = ? WHERE code = ? AND consumed_at IS NULL`,
  ),
  listInvitesUnused: db.prepare<[], InviteRow>(
    "SELECT * FROM invites WHERE consumed_at IS NULL ORDER BY created_at DESC",
  ),
  deleteInvite: db.prepare("DELETE FROM invites WHERE code = ?"),
  agentOwner: db.prepare<[string], AgentOwnerRow>(
    "SELECT * FROM agent_owners WHERE uri = ?",
  ),
  insertAgentOwner: db.prepare(
    `INSERT OR IGNORE INTO agent_owners (uri, owner_user_id, created_at)
     VALUES (?, ?, ?)`,
  ),
  agentsForUser: db.prepare<[string], AgentOwnerRow>(
    "SELECT * FROM agent_owners WHERE owner_user_id = ?",
  ),
  insertCompletedContract: db.prepare(
    `INSERT INTO completed_contracts (contract_id, job_id, poster_uri, bidder_uri, price_usd, state, ts)
     VALUES (@contract_id, @job_id, @poster_uri, @bidder_uri, @price_usd, @state, @ts)`,
  ),
  insertReceipt: db.prepare(
    `INSERT INTO receipts (receipt_id, contract_id, from_uri, to_uri, amount_usd, ts, from_wallet_id, to_wallet_id)
     VALUES (@receipt_id, @contract_id, @from_uri, @to_uri, @amount_usd, @ts, @from_wallet_id, @to_wallet_id)`,
  ),
  walletById: db.prepare<[string], WalletRow>("SELECT * FROM wallets WHERE id = ?"),
  walletByAgent: db.prepare<[string], WalletRow>(
    "SELECT * FROM wallets WHERE agent_uri = ?",
  ),
  walletsForUser: db.prepare<[string], WalletRow>(
    "SELECT * FROM wallets WHERE owner_user_id = ? ORDER BY agent_uri NULLS FIRST",
  ),
  walletsTop: db.prepare<[number], WalletRow>(
    "SELECT * FROM wallets ORDER BY balance_usd DESC LIMIT ?",
  ),
  walletsAll: db.prepare<[], WalletRow>("SELECT * FROM wallets ORDER BY balance_usd DESC"),
  insertWallet: db.prepare(
    `INSERT INTO wallets (id, owner_user_id, agent_uri, balance_usd, created_at)
     VALUES (@id, @owner_user_id, @agent_uri, @balance_usd, @created_at)`,
  ),
  setWalletBalance: db.prepare(
    "UPDATE wallets SET balance_usd = ? WHERE id = ?",
  ),
  sumWalletsForUser: db.prepare<[string], { s: number }>(
    "SELECT COALESCE(SUM(balance_usd), 0) AS s FROM wallets WHERE owner_user_id = ?",
  ),
  insertLlmCost: db.prepare(
    `INSERT INTO llm_costs (user_id, model, input_tokens, output_tokens, cost_usd, ts)
     VALUES (@user_id, @model, @input_tokens, @output_tokens, @cost_usd, @ts)`,
  ),
  llmCostsByUserSince: db.prepare<[string, number], { input_tokens: number; output_tokens: number }>(
    `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens
     FROM llm_costs WHERE user_id = ? AND ts >= ?`,
  ),
  hostLlmCostsSince: db.prepare<[number], { cost_usd: number }>(
    "SELECT COALESCE(SUM(cost_usd),0) AS cost_usd FROM llm_costs WHERE ts >= ?",
  ),
  distinctUsersSince: db.prepare<[number], { c: number }>(
    "SELECT COUNT(DISTINCT user_id) AS c FROM llm_costs WHERE ts >= ? AND user_id IS NOT NULL",
  ),
  recentSignups: db.prepare<[number], {
    id: string;
    handle: string;
    created_at: number;
    is_host: number;
    invite_note: string | null;
  }>(
    `SELECT u.id, u.handle, u.created_at, u.is_host,
            (SELECT i.note FROM invites i WHERE i.consumed_by_user = u.id) AS invite_note
     FROM users u
     ORDER BY u.created_at DESC
     LIMIT ?`,
  ),
} as const;

export const dao = {
  findUserByApiKey(apiKey: string): UserRow | undefined {
    return stmts.userByApiKeyHash.get(sha256(apiKey)) as UserRow | undefined;
  },
  findUserById(id: string): UserRow | undefined {
    return stmts.userById.get(id) as UserRow | undefined;
  },
  findUserByHandle(handle: string): UserRow | undefined {
    return stmts.userByHandle.get(handle) as UserRow | undefined;
  },
  insertUser(row: {
    id: string;
    handle: string;
    email: string | null;
    api_key_hash: string;
    balance_usd: number;
    created_at: number;
    is_host: number;
  }) {
    stmts.insertUser.run(row);
  },
  countUsers(): number {
    return (stmts.countUsers.get() as { c: number }).c;
  },
  setBalance(userId: string, balance: number) {
    stmts.setBalance.run(balance, userId);
  },
  getBalance(userId: string): number | undefined {
    const row = stmts.getBalance.get(userId) as { balance_usd: number } | undefined;
    return row?.balance_usd;
  },
  findInvite(code: string): InviteRow | undefined {
    return stmts.inviteByCode.get(code) as InviteRow | undefined;
  },
  insertInvite(row: { code: string; created_by: string | null; created_at: number; note: string | null }) {
    stmts.insertInvite.run(row);
  },
  consumeInvite(code: string, userId: string, ts: number): boolean {
    const r = stmts.consumeInvite.run(ts, userId, code);
    return r.changes === 1;
  },
  listUnusedInvites(): InviteRow[] {
    return stmts.listInvitesUnused.all() as InviteRow[];
  },
  deleteInvite(code: string): boolean {
    return stmts.deleteInvite.run(code).changes === 1;
  },
  findAgentOwner(uri: string): AgentOwnerRow | undefined {
    return stmts.agentOwner.get(uri) as AgentOwnerRow | undefined;
  },
  insertAgentOwner(uri: string, userId: string, ts: number) {
    stmts.insertAgentOwner.run(uri, userId, ts);
  },
  agentsForUser(userId: string): AgentOwnerRow[] {
    return stmts.agentsForUser.all(userId) as AgentOwnerRow[];
  },
  insertCompletedContract(row: CompletedContractRow) {
    stmts.insertCompletedContract.run(row);
  },
  insertReceipt(row: ReceiptRow) {
    stmts.insertReceipt.run({
      ...row,
      from_wallet_id: row.from_wallet_id ?? null,
      to_wallet_id: row.to_wallet_id ?? null,
    });
  },
  findWallet(id: string): WalletRow | undefined {
    return stmts.walletById.get(id) as WalletRow | undefined;
  },
  findWalletByAgent(agentUri: string): WalletRow | undefined {
    return stmts.walletByAgent.get(agentUri) as WalletRow | undefined;
  },
  walletsForUser(userId: string): WalletRow[] {
    return stmts.walletsForUser.all(userId) as WalletRow[];
  },
  listWalletsTop(limit: number): WalletRow[] {
    return stmts.walletsTop.all(limit) as WalletRow[];
  },
  listAllWallets(): WalletRow[] {
    return stmts.walletsAll.all() as WalletRow[];
  },
  insertWallet(row: WalletRow) {
    stmts.insertWallet.run(row);
  },
  setWalletBalance(id: string, balance: number) {
    stmts.setWalletBalance.run(balance, id);
  },
  sumWalletsForUser(userId: string): number {
    return (stmts.sumWalletsForUser.get(userId) as { s: number }).s;
  },
  /** Idempotent: returns existing wallet or creates it with `initialBalance`. */
  ensureWallet(opts: {
    id: string;
    ownerUserId: string;
    agentUri: string | null;
    initialBalance: number;
  }): WalletRow {
    return dao.tx(() => {
      const existing = stmts.walletById.get(opts.id) as WalletRow | undefined;
      if (existing) return existing;
      const row: WalletRow = {
        id: opts.id,
        owner_user_id: opts.ownerUserId,
        agent_uri: opts.agentUri,
        balance_usd: opts.initialBalance,
        created_at: Date.now(),
      };
      stmts.insertWallet.run(row);
      return row;
    });
  },
  insertLlmCost(row: Omit<LlmCostRow, "id">) {
    stmts.insertLlmCost.run(row);
  },
  llmTokensByUserSince(userId: string, sinceTs: number) {
    return stmts.llmCostsByUserSince.get(userId, sinceTs) as {
      input_tokens: number;
      output_tokens: number;
    };
  },
  hostLlmCostSince(sinceTs: number): number {
    return (stmts.hostLlmCostsSince.get(sinceTs) as { cost_usd: number }).cost_usd;
  },
  distinctActiveUsersSince(sinceTs: number): number {
    return (stmts.distinctUsersSince.get(sinceTs) as { c: number }).c;
  },
  recentSignups(limit: number) {
    return stmts.recentSignups.all(limit) as {
      id: string;
      handle: string;
      created_at: number;
      is_host: number;
      invite_note: string | null;
    }[];
  },
  /** Run a function inside a SQLite transaction. */
  tx<T>(fn: () => T): T {
    return db.transaction(fn)();
  },
};
