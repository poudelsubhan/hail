/**
 * Invite CLI — wraps the coordinator's host-only invite endpoints.
 *
 * Usage:
 *   pnpm invite create [--note "Alice from Coframe"]
 *   pnpm invite list
 *   pnpm invite revoke <code>
 *
 * Reads AC_HOST_API_KEY and COORDINATOR_URL from env (load order: process,
 * then .env at the workspace root). AC_PUBLIC_BASE_URL is used in the printed
 * signup URL if set — point this at your Cloudflare Tunnel URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotenv(): void {
  // Walk up from cwd to find a .env. Tiny inline impl to avoid a dependency.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, "utf8");
      for (const line of text.split("\n")) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
        if (!m) continue;
        const [, k, raw] = m;
        if (process.env[k!]) continue;
        const value = raw!.replace(/^["']|["']$/g, "");
        process.env[k!] = value;
      }
      return;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return;
    dir = parent;
  }
}
loadDotenv();

const COORD = process.env.COORDINATOR_URL ?? "http://localhost:8787";
const HOST_KEY = process.env.AC_HOST_API_KEY;
if (!HOST_KEY) {
  console.error("AC_HOST_API_KEY missing — set it in .env or your shell.");
  process.exit(1);
}

const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return args[i + 1];
}

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | { error: string } }> {
  // Only set content-type when we're sending a body. Fastify 400s on
  // `Content-Type: application/json` with an empty body.
  const headers: Record<string, string> = {
    "authorization": `Bearer ${HOST_KEY}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${COORD}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function create() {
  const note = getFlag("note");
  const { status, body } = await api<{ code: string; url: string }>("/invites", {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
  if (status !== 200 || "error" in body) {
    console.error("create failed:", status, body);
    process.exit(1);
  }
  console.log(`code:  ${body.code}`);
  console.log(`url:   ${body.url}`);
  if (note) console.log(`note:  ${note}`);
  console.log(`\nshare the signup URL or the bare code with the invitee.`);
  console.log(`they sign up with:`);
  console.log(`  curl -X POST ${COORD}/signup \\`);
  console.log(`    -H "content-type: application/json" \\`);
  console.log(`    -d '{"inviteCode":"${body.code}","handle":"<their-handle>"}'`);
}

async function list() {
  const { status, body } = await api<{ invites: Array<{ code: string; created_at: number; note: string | null }> }>(
    "/invites",
  );
  if (status !== 200 || "error" in body) {
    console.error("list failed:", status, body);
    process.exit(1);
  }
  if (body.invites.length === 0) {
    console.log("no unused invites.");
    return;
  }
  console.log(`unused invites (${body.invites.length}):\n`);
  for (const i of body.invites) {
    console.log(`  ${i.code}  ${fmtTs(i.created_at)}${i.note ? "  — " + i.note : ""}`);
  }
}

async function revoke() {
  const code = args[1];
  if (!code) {
    console.error("usage: pnpm invite revoke <code>");
    process.exit(1);
  }
  const { status, body } = await api(`/invites/${encodeURIComponent(code)}`, { method: "DELETE" });
  if (status === 200) {
    console.log(`revoked ${code}`);
    return;
  }
  console.error("revoke failed:", status, body);
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case "create": await create(); break;
    case "list":   await list(); break;
    case "revoke": await revoke(); break;
    default:
      console.error(
        "usage:\n" +
        "  pnpm invite create [--note \"Alice from Coframe\"]\n" +
        "  pnpm invite list\n" +
        "  pnpm invite revoke <code>",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
