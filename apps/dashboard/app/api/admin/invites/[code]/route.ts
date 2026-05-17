import { NextResponse } from "next/server";
import { proxyToCoord } from "@/lib/admin-proxy";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const r = await proxyToCoord(`/invites/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
  return NextResponse.json(r.body, { status: r.status });
}
