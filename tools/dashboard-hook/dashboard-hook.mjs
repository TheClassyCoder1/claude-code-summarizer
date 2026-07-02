#!/usr/bin/env node
// Claude Code "dashboard remote-control" hook — one blocking poller for both
// dashboard flows, branching on the hook event:
//   PreToolUse → route a gated tool's permission prompt to the dashboard
//   Stop       → let the dashboard send a follow-up prompt into the session
// Only acts in Dashboard mode; any error/timeout exits 0 with no decision, so
// the session falls back to normal behavior (terminal prompt / plain stop).
// Kept apart from feature-logger, whose contract is "never block a turn".

import fs from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { redactSecrets } from "../feature-logger/feature-logger.mjs";

export const GATED_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

const BASE = path.join(os.homedir(), ".claude", "feature-log");
const MODE_FILE = path.join(BASE, "mode.json");
const PENDING_DIR = path.join(BASE, "pending");
const DECISIONS_DIR = path.join(BASE, "decisions");
const AWAITING_DIR = path.join(BASE, "awaiting");
const QUEUED_DIR = path.join(BASE, "queued");
const WINDOW_MIN = 30_000;
const WINDOW_MAX = 600_000;
const POLL_MS = Number(process.env.DASHBOARD_POLL_MS) || 1000;

export function clampWindow(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return WINDOW_MAX;
  return Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, n));
}

export function shouldGate(mode, tool) {
  return mode === "dashboard" && GATED_TOOLS.has(tool);
}

export function summarizeInput(tool, toolInput) {
  const raw =
    tool === "Bash" ? toolInput?.command : toolInput?.file_path || toolInput?.notebook_path;
  if (typeof raw !== "string") return "";
  return redactSecrets(raw).slice(0, 300);
}

export function decisionOutput(decision) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: "Decided in dashboard",
    },
  };
}

export function buildContinue(prompt) {
  return { decision: "block", reason: `Dashboard prompt: ${prompt}` };
}

export function isStale(createdAt, now, windowMs) {
  const t = Date.parse(createdAt);
  return Number.isNaN(t) || now - t > windowMs;
}

// The last assistant text in the transcript — shown in the dashboard's Send box
// as "what Claude just said" context. Redacted, capped; "" on any failure.
export function lastAssistantText(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let o;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (o.type !== "assistant") continue;
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return redactSecrets(text).slice(0, 500);
    }
  } catch {
    /* missing/unreadable transcript */
  }
  return "";
}

function readControl() {
  try {
    const c = JSON.parse(fs.readFileSync(MODE_FILE, "utf8"));
    return { mode: c.mode || "cli", relayWindowMs: c.relayWindowMs };
  } catch {
    return { mode: "cli", relayWindowMs: undefined };
  }
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function rm(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `readValue()` every POLL_MS until it returns non-null or the window
// elapses. Returns the value or null. Always removes `markerFile` on exit.
async function poll(markerFile, windowMs, readValue) {
  const deadline = Date.now() + windowMs;
  try {
    while (Date.now() < deadline) {
      const v = readValue();
      if (v != null) return v;
      await sleep(POLL_MS);
    }
    return null;
  } finally {
    rm(markerFile);
  }
}

async function handleApproval(input, windowMs) {
  const sid = input.session_id;
  const tool = input.tool_name;
  if (!GATED_TOOLS.has(tool)) return;
  const pendingFile = path.join(PENDING_DIR, `${sid}.json`);
  const decisionFile = path.join(DECISIONS_DIR, `${sid}.json`);
  writeAtomic(pendingFile, {
    sessionId: sid,
    tool,
    input: summarizeInput(tool, input.tool_input),
    cwd: input.cwd || "",
    createdAt: new Date().toISOString(),
  });
  const decision = await poll(pendingFile, windowMs, () => {
    try {
      const d = JSON.parse(fs.readFileSync(decisionFile, "utf8")).decision;
      return d === "allow" || d === "deny" ? d : null;
    } catch {
      return null;
    }
  });
  if (decision) {
    rm(decisionFile);
    process.stdout.write(JSON.stringify(decisionOutput(decision)));
  }
}

async function handlePrompt(input, windowMs) {
  const sid = input.session_id;
  const awaitingFile = path.join(AWAITING_DIR, `${sid}.json`);
  const queuedFile = path.join(QUEUED_DIR, `${sid}.json`);
  writeAtomic(awaitingFile, {
    sessionId: sid,
    createdAt: new Date().toISOString(),
    lastReply: lastAssistantText(input.transcript_path),
  });
  const prompt = await poll(awaitingFile, windowMs, () => {
    try {
      const p = JSON.parse(fs.readFileSync(queuedFile, "utf8")).prompt;
      return typeof p === "string" && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  });
  if (prompt != null) {
    rm(queuedFile);
    process.stdout.write(JSON.stringify(buildContinue(prompt)));
  }
}

async function main() {
  if (process.env.FEATURE_LOGGER_ACTIVE === "1") return;
  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }
  if (!input.session_id) return;
  const { mode, relayWindowMs } = readControl();
  if (mode !== "dashboard") return;
  const windowMs = clampWindow(relayWindowMs ?? WINDOW_MAX);
  if (input.hook_event_name === "PreToolUse") return handleApproval(input, windowMs);
  if (input.hook_event_name === "Stop") return handlePrompt(input, windowMs);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
