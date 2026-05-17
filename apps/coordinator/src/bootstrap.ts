import { db, dao, generateApiKey, nanoid, sha256, userWalletId } from "./db/index.js";

const HOST_STARTING_BALANCE_USD = Number(process.env.AC_HOST_STARTING_BALANCE_USD ?? "100.00");

/**
 * On first boot (empty users table) we materialize the host user. Re-running
 * the coordinator must be a no-op — balances stay where the marketplace left
 * them.
 */
export function bootstrapHost(): { created: boolean; handle: string; apiKey?: string } {
  const handle = process.env.AC_HOST_HANDLE ?? "host";
  const envApiKey = process.env.AC_HOST_API_KEY;

  if (dao.countUsers() > 0) {
    // Reconcile host key when env-supplied — lets the operator rotate the
    // key without wiping balances. Only updates if there's a mismatch.
    if (envApiKey) {
      const existing = dao.findUserByHandle(handle);
      const newHash = sha256(envApiKey);
      if (existing && existing.is_host && existing.api_key_hash !== newHash) {
        db.prepare("UPDATE users SET api_key_hash = ? WHERE id = ?").run(newHash, existing.id);
        console.error(`[bootstrap] host apiKey rotated for handle=${handle}`);
      }
    }
    // Backfill user-default wallets for existing users that predate v3.
    for (const u of db.prepare("SELECT id, balance_usd FROM users").all() as { id: string; balance_usd: number }[]) {
      dao.ensureWallet({
        id: userWalletId(u.id),
        ownerUserId: u.id,
        agentUri: null,
        initialBalance: u.balance_usd,
      });
    }
    return { created: false, handle };
  }
  const apiKey = envApiKey ?? generateApiKey();
  const id = `usr_${nanoid(6)}`;
  const now = Date.now();
  dao.insertUser({
    id,
    handle,
    email: null,
    api_key_hash: sha256(apiKey),
    balance_usd: HOST_STARTING_BALANCE_USD,
    created_at: now,
    is_host: 1,
  });
  dao.ensureWallet({
    id: userWalletId(id),
    ownerUserId: id,
    agentUri: null,
    initialBalance: HOST_STARTING_BALANCE_USD,
  });
  // eslint-disable-next-line no-console
  console.error(
    `\n[bootstrap] host user created: handle=${handle}, apiKey=${apiKey}  (save this — it is only printed once)\n`,
  );
  return { created: true, handle, apiKey };
}
