import { test } from "node:test";
import assert from "node:assert/strict";
import { stripOurHooks } from "./uninstall.mjs";

const OURS = "~/.claude/feature-logger/feature-logger.mjs";

test("removes our hook and drops the now-empty group, keeps others", () => {
  const arr = [
    { matcher: "", hooks: [{ type: "command", command: OURS }] },
    { matcher: "", hooks: [{ type: "command", command: "other-tool.mjs" }] },
  ];
  const { next, removed } = stripOurHooks(arr);
  assert.equal(removed, 1);
  assert.equal(next.length, 1);
  assert.equal(next[0].hooks[0].command, "other-tool.mjs");
});

test("keeps a group that mixes our hook with someone else's, dropping only ours", () => {
  const arr = [
    {
      matcher: "",
      hooks: [
        { type: "command", command: OURS },
        { type: "command", command: "other-tool.mjs" },
      ],
    },
  ];
  const { next, removed } = stripOurHooks(arr);
  assert.equal(removed, 1);
  assert.equal(next.length, 1);
  assert.deepEqual(
    next[0].hooks.map((h) => h.command),
    ["other-tool.mjs"],
  );
});

test("no-op when our hook is absent", () => {
  const arr = [{ matcher: "", hooks: [{ command: "other-tool.mjs" }] }];
  const { removed } = stripOurHooks(arr);
  assert.equal(removed, 0);
});

test("tolerates undefined / non-array input", () => {
  assert.deepEqual(stripOurHooks(undefined), { next: undefined, removed: 0 });
});
