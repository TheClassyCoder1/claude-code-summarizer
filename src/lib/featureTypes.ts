// Client-safe types + pure helpers (no Node imports), so client components can
// use them without dragging the fs-based reader into the browser bundle.

import type { TokenCounts } from "./pricing";

export type FileBucket = { created: string[]; edited: string[] };

export type FeatureRecord = {
  schemaVersion: number;
  sessionId: string;
  projectPath: string;
  projectName: string;
  model: string;
  tokens: TokenCounts;
  turns: number;
  filesByArea: Record<string, FileBucket>;
  commands: string[];
  userPrompts: string[];
  summary: string;
  summaryHeadline: string;
  summarySource: string;
  summaryUsage?: unknown;
  summaryCostUsd?: number;
  startedAt: string;
  endedAt: string;
  updatedAt: string;
  // Derived in the reader:
  estimatedCostUsd: number;
  totalTokens: number;
};

export type Aggregates = {
  features: number;
  projects: number;
  totalTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
};

export function aggregate(records: FeatureRecord[]): Aggregates {
  return {
    features: records.length,
    projects: new Set(records.map((r) => r.projectPath)).size,
    totalTokens: records.reduce((s, r) => s + r.totalTokens, 0),
    totalOutputTokens: records.reduce((s, r) => s + r.tokens.output, 0),
    totalCostUsd: records.reduce((s, r) => s + r.estimatedCostUsd, 0),
  };
}
