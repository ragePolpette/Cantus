import fs from "node:fs";
import path from "node:path";
import { MODEL_DIR } from "./index.js";

/** What Cantus rebuilds on every run, kept out of git: the map (`model.json`) and the block notes stay tracked. */
export const CANTUS_IGNORE = ["# Written by Cantus: rebuilt on every run, not part of the project.", "# The map (model.json) is not listed here: it is meant to be committed.", "cache/", "runs/", "worktrees/", "*.log", "*.html", ""].join("\n");

/** What of `.cantus/` a repository should not hold, as git lists tracked files (relative to the project). */
export function isRebuiltCantusFile(file: string): boolean {
  return file.startsWith(`${MODEL_DIR}/cache/`) || file.startsWith(`${MODEL_DIR}/runs/`) || (path.posix.dirname(file) === MODEL_DIR && /\.(?:log|html)$/.test(file));
}

/**
 * Writes `.cantus/.gitignore` the first time Cantus writes anything it rebuilds there. Without it a
 * `git add -A` commits the cache (megabytes that change on every run), and two worktrees merging
 * clash over it. An existing file is the user's and is left as it is.
 */
export function ensureCantusIgnore(root: string): void {
  try {
    const dir = path.join(root, MODEL_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".gitignore"), CANTUS_IGNORE, { flag: "wx" });
  } catch {
    // already there, or a read-only checkout
  }
}
