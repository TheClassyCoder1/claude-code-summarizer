#!/usr/bin/env node
// Removes the feature-logger global hook installed by install.mjs.
//
// Safe & idempotent:
//   - strips our hook entries from ~/.claude/settings.json (backs up first)
//   - NEVER touches ~/.claude/launcher-settings.json (managed/cloud config)
//   - deletes the copied script dir ~/.claude/feature-logger/
//   - leaves your captured records in ~/.claude/feature-log/ untouched
//
// Run from the repo: node tools/feature-logger/uninstall.mjs

import fs from "fs";
import { DEST_DIR, SETTINGS_PATH, HOOK_COMMAND, writeJsonAtomic } from "./shared.mjs";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// Drop hook groups that reference our command; keep everything else.
export function stripOurHooks(arr) {
  if (!Array.isArray(arr)) return { next: arr, removed: 0 };
  let removed = 0;
  const next = arr
    .map((e) => {
      if (!Array.isArray(e?.hooks)) return e;
      const hooks = e.hooks.filter((h) => h?.command !== HOOK_COMMAND);
      removed += e.hooks.length - hooks.length;
      return { ...e, hooks };
    })
    // Drop now-empty groups (a group we fully cleared).
    .filter((e) => !Array.isArray(e?.hooks) || e.hooks.length > 0);
  return { next, removed };
}

function main() {
  // 1. Edit settings.json (NOT launcher-settings.json).
  if (fs.existsSync(SETTINGS_PATH)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    } catch {
      log(`! ${SETTINGS_PATH} is not valid JSON — aborting so it isn't clobbered.`);
      return;
    }
    let changed = false;
    if (settings.hooks && typeof settings.hooks === "object") {
      for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
        const { next, removed } = stripOurHooks(settings.hooks[event]);
        if (removed > 0) {
          settings.hooks[event] = next;
          if (Array.isArray(next) && next.length === 0) delete settings.hooks[event];
          changed = true;
          log(`✓ ${event}: removed feature-logger hook`);
        }
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    if (changed) {
      const backup = `${SETTINGS_PATH}.bak-${Date.now()}`;
      fs.copyFileSync(SETTINGS_PATH, backup);
      log(`✓ Backed up settings → ${backup}`);
      writeJsonAtomic(SETTINGS_PATH, settings);
      log(`✓ Wrote ${SETTINGS_PATH}`);
    } else {
      log("• No feature-logger hooks found in settings.json — nothing to remove.");
    }
  } else {
    log("• No settings.json found — nothing to remove.");
  }

  // 2. Delete the copied script dir.
  if (fs.existsSync(DEST_DIR)) {
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
    log(`✓ Removed ${DEST_DIR}`);
  }

  log("\nDone. Captured records remain in ~/.claude/feature-log/ (delete manually if you want).");
  log("Start a NEW Claude Code session for the change to take effect.");
}

// Entry guard: only mutate ~/.claude when run directly, never on test import.
import { pathToFileURL } from "url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
