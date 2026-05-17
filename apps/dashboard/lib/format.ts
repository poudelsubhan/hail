export function usd(n: number, digits = 4): string {
  return `$${n.toFixed(digits)}`;
}

export function ms(n: number): string {
  if (n === 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function shortTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." +
    String(d.getMilliseconds()).padStart(3, "0");
}

export function shortUri(uri: string): string {
  return uri.replace(/^agent:\/\//, "").replace(/\.local$/, "");
}
