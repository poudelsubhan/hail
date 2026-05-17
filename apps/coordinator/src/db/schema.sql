-- Agent Classifieds v2 schema. Persists only outcome-bearing state.
-- Ephemeral marketplace state (jobs, bids, live contracts) stays in memory.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  email TEXT,
  api_key_hash TEXT NOT NULL,
  balance_usd REAL NOT NULL DEFAULT 5.00,
  created_at INTEGER NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_user TEXT REFERENCES users(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS agent_owners (
  uri TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completed_contracts (
  contract_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  poster_uri TEXT NOT NULL,
  bidder_uri TEXT NOT NULL,
  price_usd REAL NOT NULL,
  state TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  from_uri TEXT NOT NULL,
  to_uri TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  ts INTEGER NOT NULL,
  from_wallet_id TEXT,
  to_wallet_id TEXT
);

-- v3: per-agent wallets. A user has one user-default wallet
-- (id=wlt_user_<userId>, agent_uri NULL) plus one per registered agent
-- (id=wlt_<handle>_<slug>, agent_uri=<the URI>). The user-default wallet
-- mirrors users.balance_usd; agent wallets are independent sub-balances.
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  agent_uri TEXT,
  balance_usd REAL NOT NULL DEFAULT 0.00,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallets_owner ON wallets(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_agent ON wallets(agent_uri) WHERE agent_uri IS NOT NULL;

CREATE TABLE IF NOT EXISTS llm_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_ts ON receipts(ts);
CREATE INDEX IF NOT EXISTS idx_completed_contracts_ts ON completed_contracts(ts);
CREATE INDEX IF NOT EXISTS idx_llm_costs_user_ts ON llm_costs(user_id, ts);
