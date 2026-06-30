// Rough USD cost estimation from token counts. Prices are USD per 1M tokens.
// Cache reads bill at ~0.1× input; cache writes at ~1.25× input.

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

type Price = { in: number; out: number };

const PRICING: Record<string, Price> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

const FALLBACK: Price = { in: 5, out: 25 }; // assume Opus-tier for unknown models

// Strip provider prefix, context-window tag, and trailing date from a model ID.
// Shared base-cleaning step used by both normalizeModel and shortModel (format.ts).
export function cleanModelId(model: string): string {
  return model
    .replace(/^.*\./, "") // drop "us.anthropic." style prefix
    .replace(/\[.*?\]$/, "") // drop "[1m]" context-window tag
    .replace(/-\d{8}$/, ""); // drop trailing YYYYMMDD date
}

// Transcripts emit IDs like "us.anthropic.claude-sonnet-4-6-20260101" or
// "claude-opus-4-8[1m]". Strip the provider prefix, context-window tag, and
// trailing date so they match the bare keys in PRICING.
export function normalizeModel(model: string): string {
  const base = cleanModelId(model);
  if (PRICING[base]) return base;
  // Fall back to the longest known key that prefixes the (cleaned) id.
  const match = Object.keys(PRICING)
    .filter((k) => base.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ?? base;
}

export function totalTokenCount(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

export function estimateCostUsd(model: string, t: TokenCounts): number {
  const p = PRICING[normalizeModel(model)] ?? FALLBACK;
  return (
    (t.input / 1e6) * p.in +
    (t.output / 1e6) * p.out +
    (t.cacheRead / 1e6) * p.in * 0.1 +
    (t.cacheCreation / 1e6) * p.in * 1.25
  );
}
