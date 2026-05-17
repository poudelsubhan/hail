import { NextRequest, NextResponse } from "next/server";

// Server-side coord URL — kept separate from NEXT_PUBLIC_COORD_URL so a deploy
// could route the signup proxy through an internal hostname while the browser
// continues talking to the public coordinator. Falls back to the public one.
const COORD = process.env.AC_COORD_URL ?? process.env.NEXT_PUBLIC_COORD_URL ?? "http://localhost:8787";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const res = await fetch(`${COORD}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: res.status });
  } catch {
    return new NextResponse(text, { status: res.status });
  }
}
