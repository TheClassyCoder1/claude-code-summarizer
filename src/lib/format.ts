// Deterministic formatters (no locale/timezone) so server and client render
// identically and don't trigger hydration mismatches.

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`;
  return String(n);
}

export function formatUsd(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDate(iso: string): string {
  // yyyy-mm-dd from an ISO timestamp; falls back to the raw value.
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : iso;
}
