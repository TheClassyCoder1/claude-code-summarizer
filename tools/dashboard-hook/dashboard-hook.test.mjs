import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  shouldGate,
  summarizeInput,
  decisionOutput,
  buildContinue,
  isStale,
  clampWindow,
  lastAssistantText,
} from "./dashboard-hook.mjs";

test("lastAssistantText: last assistant text blocks, redacted, capped", () => {
  const lines = [
    { type: "user", message: { content: "hi" } },
    { type: "assistant", message: { content: [{ type: "text", text: "first reply" }] } },
    { type: "user", message: { content: "again" } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "Done. Key sk-ant-abc123XYZ456def789ghi saved." },
        ],
      },
    },
  ];
  const file = path.join(os.tmpdir(), `dh-transcript-${process.pid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  const text = lastAssistantText(file);
  fs.unlinkSync(file);
  assert.match(text, /^Done\./);
  assert.match(text, /\[redacted\]/);
  assert.doesNotMatch(text, /first reply/);
});

test("lastAssistantText: caps length and survives a missing file", () => {
  const file = path.join(os.tmpdir(), `dh-long-${process.pid}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "y".repeat(2000) }] } }),
  );
  assert.equal(lastAssistantText(file).length, 500);
  fs.unlinkSync(file);
  assert.equal(lastAssistantText("/nope/missing.jsonl"), "");
});

test("shouldGate: only dashboard mode + gated tools", () => {
  assert.equal(shouldGate("dashboard", "Bash"), true);
  assert.equal(shouldGate("dashboard", "Read"), false);
  assert.equal(shouldGate("cli", "Bash"), false);
});

test("summarizeInput: command/file, redacted, truncated", () => {
  assert.equal(summarizeInput("Bash", { command: "npm test" }), "npm test");
  assert.equal(summarizeInput("Write", { file_path: "/repo/a.ts" }), "/repo/a.ts");
  assert.match(summarizeInput("Bash", { command: "echo sk-ant-abc123XYZ456def789ghi" }), /\[redacted\]/);
  assert.equal(summarizeInput("Bash", { command: "x".repeat(500) }).length, 300);
});

test("decisionOutput: PreToolUse permission payload", () => {
  assert.deepEqual(decisionOutput("allow"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Decided in dashboard",
    },
  });
});

test("buildContinue: Stop block payload", () => {
  assert.deepEqual(buildContinue("run tests"), { decision: "block", reason: "Dashboard prompt: run tests" });
});

test("clampWindow: [30s,600s], default on garbage", () => {
  assert.equal(clampWindow(1000), 30_000);
  assert.equal(clampWindow(9_000_000), 600_000);
  assert.equal(clampWindow(120_000), 120_000);
  assert.equal(clampWindow("x"), 600_000);
});

test("isStale: true past window", () => {
  const now = 1_000_000;
  assert.equal(isStale(new Date(now - 10_000).toISOString(), now, 300_000), false);
  assert.equal(isStale(new Date(now - 400_000).toISOString(), now, 300_000), true);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "dashboard-hook.mjs");

function runHook(home, event, env = {}) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, HOME: home, DASHBOARD_POLL_MS: "50", ...env },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(JSON.stringify(event));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

function dashboardHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
  const base = path.join(home, ".claude", "feature-log");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "mode.json"), JSON.stringify({ mode: "dashboard", relayWindowMs: 30_000 }));
  return { home, base };
}

test("PreToolUse: waits for a decision, emits allow, cleans up", async () => {
  const { home, base } = dashboardHome();
  const sid = "sess-a";
  const p = runHook(home, {
    hook_event_name: "PreToolUse",
    session_id: sid,
    tool_name: "Bash",
    tool_input: { command: "rm -rf build" },
    cwd: "/repo",
  });
  await new Promise((r) => setTimeout(r, 150));
  const pendingFile = path.join(base, "pending", `${sid}.json`);
  assert.ok(fs.existsSync(pendingFile), "pending written");
  assert.equal(JSON.parse(fs.readFileSync(pendingFile, "utf8")).input, "rm -rf build");
  fs.mkdirSync(path.join(base, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(base, "decisions", `${sid}.json`), JSON.stringify({ decision: "allow" }));
  const { code, out } = await p;
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(fs.existsSync(pendingFile), false);
  assert.equal(fs.existsSync(path.join(base, "decisions", `${sid}.json`)), false);
});

test("PreToolUse: non-gated tool is a no-op", async () => {
  const { home } = dashboardHome();
  const { code, out } = await runHook(home, {
    hook_event_name: "PreToolUse",
    session_id: "s",
    tool_name: "Read",
    tool_input: {},
    cwd: "/repo",
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), "");
});

test("Stop: waits, injects queued prompt as continuation, cleans up", async () => {
  const { home, base } = dashboardHome();
  const sid = "sess-b";
  const transcript = path.join(base, `${sid}-transcript.jsonl`);
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "All tests pass." }] } }),
  );
  const p = runHook(home, {
    hook_event_name: "Stop",
    session_id: sid,
    cwd: "/repo",
    transcript_path: transcript,
  });
  await new Promise((r) => setTimeout(r, 150));
  const awaitingFile = path.join(base, "awaiting", `${sid}.json`);
  assert.ok(fs.existsSync(awaitingFile), "awaiting written");
  assert.equal(JSON.parse(fs.readFileSync(awaitingFile, "utf8")).lastReply, "All tests pass.");
  fs.mkdirSync(path.join(base, "queued"), { recursive: true });
  fs.writeFileSync(path.join(base, "queued", `${sid}.json`), JSON.stringify({ prompt: "fix the bug" }));
  const { code, out } = await p;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { decision: "block", reason: "Dashboard prompt: fix the bug" });
  assert.equal(fs.existsSync(awaitingFile), false);
  assert.equal(fs.existsSync(path.join(base, "queued", `${sid}.json`)), false);
});

test("cli mode: instant no-op for both events", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
  fs.mkdirSync(path.join(home, ".claude", "feature-log"), { recursive: true });
  const a = await runHook(home, { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: {}, cwd: "/r" });
  const b = await runHook(home, { hook_event_name: "Stop", session_id: "s", cwd: "/r" });
  assert.equal(a.out.trim(), "");
  assert.equal(b.out.trim(), "");
});
