import { NextResponse } from "next/server";
import { proxyToCoord } from "@/lib/admin-proxy";

export async function GET() {
  const r = await proxyToCoord("/admin/recent?limit=10");
  return NextResponse.json(r.body, { status: r.status });
}
