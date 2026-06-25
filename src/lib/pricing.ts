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

export function estimateCostUsd(model: string, t: TokenCounts): number {
  const p = PRICING[model] ?? FALLBACK;
  return (
    (t.input / 1e6) * p.in +
    (t.output / 1e6) * p.out +
    (t.cacheRead / 1e6) * p.in * 0.1 +
    (t.cacheCreation / 1e6) * p.in * 1.25
  );
}
