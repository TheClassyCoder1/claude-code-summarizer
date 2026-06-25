import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, normalizeModel } from "./pricing.ts";

test("normalizeModel strips date suffix to the base model id", () => {
  assert.equal(normalizeModel("claude-sonnet-4-6-20260101"), "claude-sonnet-4-6");
  assert.equal(normalizeModel("claude-opus-4-8"), "claude-opus-4-8");
});

test("normalizeModel strips provider prefix and context-window tag", () => {
  assert.equal(normalizeModel("us.anthropic.claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModel("claude-opus-4-8[1m]"), "claude-opus-4-8");
});

test("dated Sonnet id is billed at Sonnet rate, not the Opus fallback", () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 };
  // Sonnet input = $3/M, Opus input = $5/M. Dated id must not fall back to Opus.
  assert.equal(estimateCostUsd("claude-sonnet-4-6-20260101", tokens), 3);
});

test("dated Haiku id is billed at Haiku rate", () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 };
  assert.equal(estimateCostUsd("claude-haiku-4-5-20251001", tokens), 1);
});

test("truly unknown model still falls back to Opus-tier", () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 };
  assert.equal(estimateCostUsd("some-future-model", tokens), 5);
});

test("output and cache tokens price as documented", () => {
  const t = { input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 };
  // Opus: out 25, cacheRead 5*0.1=0.5, cacheCreation 5*1.25=6.25 → 31.75
  assert.equal(estimateCostUsd("claude-opus-4-8", t), 31.75);
});
