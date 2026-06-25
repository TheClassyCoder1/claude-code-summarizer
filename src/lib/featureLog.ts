import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { z } from "zod";
import { estimateCostUsd } from "./pricing";
import type { FeatureRecord } from "./featureTypes";

export type { FeatureRecord, Aggregates } from "./featureTypes";
export { aggregate } from "./featureTypes";

// Reads the per-session records written by the feature-logger hook
// (~/.claude/feature-log/<project-slug>/<session_id>.json) for the dashboard.

const tokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheCreation: z.number(),
});

const recordSchema = z.object({
  schemaVersion: z.number(),
  sessionId: z.string(),
  projectPath: z.string(),
  projectName: z.string(),
  model: z.string(),
  tokens: tokensSchema,
  turns: z.number(),
  filesByArea: z.record(
    z.string(),
    z.object({ created: z.array(z.string()), edited: z.array(z.string()) }),
  ),
  commands: z.array(z.string()),
  userPrompts: z.array(z.string()),
  summary: z.string(),
  summaryHeadline: z.string(),
  summarySource: z.string(),
  summaryUsage: z.unknown().optional(),
  summaryCostUsd: z.number().optional(),
  startedAt: z.string(),
  endedAt: z.string(),
  updatedAt: z.string(),
});

const FEATURE_LOG_DIR = path.join(os.homedir(), ".claude", "feature-log");

/** All feature records on this machine, newest first. */
export async function readFeatureRecords(): Promise<FeatureRecord[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(FEATURE_LOG_DIR);
  } catch {
    return []; // hook not installed / nothing captured yet
  }

  const records: FeatureRecord[] = [];
  for (const proj of projectDirs) {
    const dir = path.join(FEATURE_LOG_DIR, proj);
    let files: string[];
    try {
      if (!(await fs.stat(dir)).isDirectory()) continue;
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const parsed = recordSchema.safeParse(
          JSON.parse(await fs.readFile(path.join(dir, file), "utf8")),
        );
        if (!parsed.success) continue;
        const r = parsed.data;
        const totalTokens =
          r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheCreation;
        records.push({
          ...r,
          estimatedCostUsd: estimateCostUsd(r.model, r.tokens),
          totalTokens,
        });
      } catch {
        // skip unreadable file
      }
    }
  }

  return records.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}
