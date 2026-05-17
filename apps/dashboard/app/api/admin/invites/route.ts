import { NextRequest, NextResponse } from "next/server";
import { proxyToCoord } from "@/lib/admin-proxy";

export async function GET() {
  const r = await proxyToCoord("/invites");
  return NextResponse.json(r.body, { status: r.status });
}

export async function POST(req: NextRequest) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body — coord accepts {} */
  }
  const r = await proxyToCoord("/invites", { method: "POST", body });
  return NextResponse.json(r.body, { status: r.status });
}
