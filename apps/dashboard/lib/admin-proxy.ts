// Shared helper for /api/admin/* routes — forwards to the coordinator with
// the host's Bearer apiKey injected server-side, so the apiKey never reaches
// the browser. The /admin route is wrapped by middleware basic-auth.

const COORD = process.env.AC_COORD_URL ?? process.env.NEXT_PUBLIC_COORD_URL ?? "http://localhost:8787";
const HOST_KEY = process.env.AC_HOST_API_KEY;

export async function proxyToCoord(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  if (!HOST_KEY) {
    return {
      status: 500,
      body: {
        error: "ac_host_api_key_unset",
        hint: "Set AC_HOST_API_KEY in the dashboard env (Vercel project settings).",
      },
    };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${HOST_KEY}`,
  };
  let bodyText: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    bodyText = JSON.stringify(init.body);
  }
  const res = await fetch(`${COORD}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: bodyText,
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body: parsed };
}
