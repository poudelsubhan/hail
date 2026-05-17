import { NextRequest, NextResponse } from "next/server";

const REALM = "ac-admin";

/**
 * HTTP basic auth gate for /admin and /api/admin/*. Stopgap — fine for the
 * hackathon demo, obviously not real auth (no rate limit, no MFA). Replace
 * with a session model post-hackathon.
 *
 * Env: ADMIN_USER (default "admin"), ADMIN_PASSWORD (default "password").
 * MUST be overridden in deploy env before sharing the dashboard URL.
 */
export function middleware(req: NextRequest) {
  const user = process.env.ADMIN_USER ?? "admin";
  const pass = process.env.ADMIN_PASSWORD ?? "password";

  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      if (u === user && p === pass) return NextResponse.next();
    }
  }

  return new NextResponse("authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${REALM}"` },
  });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
