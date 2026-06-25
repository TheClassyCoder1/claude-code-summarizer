#!/usr/bin/env node
// Claude Code "feature logger" hook — standalone, zero dependencies.
//
// Registered as a global Stop + SessionEnd hook (see install.mjs). On each turn it
// cheaply records what a session did (files changed, tokens, commands, prompts) to
// ~/.claude/feature-log/<slug>/<session_id>.json. At session end it adds a
// natural-language "what we did" summary written by `claude -p` (your Claude Code
// subscription — no API key). The companion Next.js app reads these files.
//
// It never blocks your turn: every path exits 0, all work is wrapped in try/catch.

import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Parsing helpers (kept in sync with the app's src/lib/claudeCode.ts logic).
// ---------------------------------------------------------------------------
const MUTATING = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const SIGNIFICANT_CMD =
  /\b(git\s+(commit|push|merge|rebase|tag)|npm\s+(install|i|ci)|npx\s+create-|prisma\s+migrate|npm\s+run\s+(build|test|lint)|yarn\s+\w|pnpm\s+(install|add))/;

const INJECTION = [
  /^Base directory for this skill/,
  /^<command-/,
  /^Caveat:/i,
  /system-reminder/i,
  /^\[Request interrupted/,
  /^Result of calling/,
  /^The user (opened|approved|rejected|selected)/,
  /^API Error/,
  /^Continue from where you left off/i,
];

const CONFIG_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "eslint.config.mjs",
  "eslint.config.js",
  ".eslintrc.json",
  "postcss.config.mjs",
  "postcss.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  ".gitignore",
  "next-env.d.ts",
  "components.json",
]);

function classify(rel) {
  const base = rel.split("/").pop() || rel;
  if (CONFIG_FILES.has(base) || base.startsWith(".env")) return "Project setup";
  if (rel.startsWith("src/lib/") || rel.startsWith("lib/")) return "Data layer & libs";
  if (rel.startsWith("src/app/api/") || rel.startsWith("app/api/") || rel.startsWith("pages/api/"))
    return "API routes";
  if (rel.startsWith("src/components/") || rel.startsWith("components/")) return "Board UI";
  if (rel.startsWith("src/app/") || rel.startsWith("app/")) return "Board UI";
  if (base.endsWith(".md")) return "Docs";
  return "Other";
}

function isRealPrompt(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t || t.length > 1500) return false;
  return !INJECTION.some((re) => re.test(t));
}

function slugForCwd(cwd) {
  // Mirror Claude Code's own project-dir scheme: replace "/" with "-".
  return (cwd || "unknown").replace(/\//g, "-");
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------
function parseTranscript(transcriptPath, fallbackCwd) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");

  let cwd = "";
  let model = "";
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const created = new Set();
  const edited = new Set();
  const commands = [];
  const userPrompts = [];
  let turns = 0;
  let startedAt = null;
  let endedAt = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof o.cwd === "string") cwd = o.cwd;

    if (typeof o.timestamp === "string") {
      if (!startedAt || o.timestamp < startedAt) startedAt = o.timestamp;
      if (!endedAt || o.timestamp > endedAt) endedAt = o.timestamp;
    }

    if (o.type === "user") {
      const content = o.message?.content;
      if (isRealPrompt(content)) userPrompts.push(content.trim().slice(0, 300));
    } else if (o.type === "assistant") {
      turns++;
      const u = o.message?.usage;
      if (u) {
        tokens.input += u.input_tokens || 0;
        tokens.output += u.output_tokens || 0;
        tokens.cacheRead += u.cache_read_input_tokens || 0;
        tokens.cacheCreation += u.cache_creation_input_tokens || 0;
      }
      if (o.message?.model) model = o.message.model;
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || b.type !== "tool_use") continue;
          const inp = b.input || {};
          if (b.name === "Write" && typeof inp.file_path === "string") created.add(inp.file_path);
          else if (MUTATING.has(b.name)) {
            const fp = inp.file_path || inp.notebook_path;
            if (typeof fp === "string") edited.add(fp);
          } else if (b.name === "Bash" && typeof inp.command === "string") {
            commands.push(inp.command);
          }
        }
      }
    }
  }

  const effectiveCwd = cwd || fallbackCwd || "";
  const rel = (f) => {
    if (effectiveCwd && f.startsWith(effectiveCwd + "/")) return f.slice(effectiveCwd.length + 1);
    return effectiveCwd ? null : f; // outside project → skip when we know cwd
  };

  const filesByArea = {};
  const bucket = (f, kind) => {
    const r = rel(f);
    if (!r) return;
    const area = classify(r);
    if (!filesByArea[area]) filesByArea[area] = { created: [], edited: [] };
    filesByArea[area][kind].push(r);
  };
  created.forEach((f) => bucket(f, "created"));
  edited.forEach((f) => {
    if (!created.has(f)) bucket(f, "edited");
  });
  // Sort & dedupe each bucket for stable output.
  for (const area of Object.keys(filesByArea)) {
    filesByArea[area].created = [...new Set(filesByArea[area].created)].sort();
    filesByArea[area].edited = [...new Set(filesByArea[area].edited)].sort();
  }

  const sigCommands = [
    ...new Set(commands.map((c) => c.split("\n")[0].trim()).filter((c) => SIGNIFICANT_CMD.test(c))),
  ].slice(0, 10);

  return {
    projectPath: effectiveCwd,
    projectName: effectiveCwd ? path.basename(effectiveCwd) : "unknown",
    model: model || "claude-opus-4-8",
    tokens,
    turns,
    filesByArea,
    commands: sigCommands,
    userPrompts: userPrompts.slice(-12),
    startedAt: startedAt || new Date().toISOString(),
    endedAt: endedAt || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persistence (atomic, idempotent per session_id)
// ---------------------------------------------------------------------------
function recordPath(sessionId, projectPath) {
  const dir = path.join(os.homedir(), ".claude", "feature-log", slugForCwd(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.json`);
}

function readExisting(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Summary (SessionEnd): compact prompt → `claude -p`, heuristic fallback
// ---------------------------------------------------------------------------
function buildSummaryPrompt(rec) {
  const areaLines = Object.entries(rec.filesByArea).map(([area, f]) => {
    const c = f.created.slice(0, 12);
    const e = f.edited.slice(0, 12);
    const bits = [];
    if (c.length) bits.push(`created ${c.join(", ")}`);
    if (e.length) bits.push(`edited ${e.join(", ")}`);
    return `- ${area}: ${bits.join("; ")}`;
  });
  return [
    "Summarize a coding work session for a dashboard. Be specific and factual.",
    "",
    `Project: ${rec.projectName} (${rec.projectPath})`,
    "",
    "What the user asked for:",
    ...rec.userPrompts.slice(0, 10).map((p) => `- ${p}`),
    "",
    "Files changed, by area:",
    ...(areaLines.length ? areaLines : ["- (none)"]),
    "",
    rec.commands.length ? `Key commands: ${rec.commands.join(" ; ")}` : "",
    "",
    "Write plain text (no markdown): first line is a short headline (<= 10 words) of what was",
    "accomplished; then 2-4 sentences describing what was built and why.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function heuristicSummary(rec) {
  const areas = Object.keys(rec.filesByArea);
  let created = 0;
  let edited = 0;
  for (const a of areas) {
    created += rec.filesByArea[a].created.length;
    edited += rec.filesByArea[a].edited.length;
  }
  const headline = `Worked on ${rec.projectName}` + (areas.length ? ` (${areas.join(", ")})` : "");
  const body =
    `Created ${created} and edited ${edited} file(s)` +
    (areas.length ? ` across ${areas.join(", ")}.` : ".") +
    (rec.commands.length ? ` Key commands: ${rec.commands.slice(0, 4).join("; ")}.` : "");
  return { headline, text: `${headline}\n${body}` };
}

function summarizeWithClaude(rec) {
  const prompt = buildSummaryPrompt(rec);
  try {
    const res = spawnSync("claude", ["-p", prompt, "--output-format", "json"], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, FEATURE_LOGGER_ACTIVE: "1" },
    });
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout);
    const text = (parsed.result || "").trim();
    if (!text) return null;
    return {
      summary: text,
      summaryHeadline: text.split("\n")[0].slice(0, 120),
      summarySource: "claude",
      summaryUsage: parsed.usage || undefined,
      summaryCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  // Recursion guard: our own `claude -p` child inherits this.
  if (process.env.FEATURE_LOGGER_ACTIVE === "1") return;

  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  if (input.stop_hook_active === true) return; // avoid Stop-driven recursion

  const event = input.hook_event_name || "Stop";
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) return;

  const base = parseTranscript(transcriptPath, input.cwd);
  const file = recordPath(sessionId, base.projectPath);
  const existing = readExisting(file) || {};

  const record = {
    schemaVersion: 1,
    sessionId,
    ...base,
    // Preserve any summary already written (e.g. a late Stop after SessionEnd).
    summary: existing.summary || "",
    summaryHeadline: existing.summaryHeadline || "",
    summarySource: existing.summarySource || "",
    summaryUsage: existing.summaryUsage,
    summaryCostUsd: existing.summaryCostUsd,
    updatedAt: new Date().toISOString(),
  };

  if (event === "SessionEnd") {
    const summary = summarizeWithClaude(base) || {
      ...heuristicSummary(base),
      summarySource: "heuristic",
    };
    record.summary = summary.summary ?? summary.text;
    record.summaryHeadline = summary.summaryHeadline ?? summary.headline;
    record.summarySource = summary.summarySource;
    record.summaryUsage = summary.summaryUsage;
    record.summaryCostUsd = summary.summaryCostUsd;
  }

  writeAtomic(file, record);
}

try {
  main();
} catch {
  // never block the user's turn
}
process.exit(0);
