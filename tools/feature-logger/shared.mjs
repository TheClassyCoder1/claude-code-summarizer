// Shared constants and utilities for the feature-logger tool scripts.
// Used by install.mjs, uninstall.mjs, and feature-logger.mjs.

import fs from "fs";
import path from "path";
import os from "os";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const DEST_DIR = path.join(CLAUDE_DIR, "feature-logger");
export const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
export const HOOK_COMMAND = "~/.claude/feature-logger/feature-logger.mjs";

/** Read and parse a JSON file, returning null on any failure. */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write a JSON object atomically (write to .tmp, then rename). */
export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
