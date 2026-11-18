import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readRegistry } from "./worktree-registry.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** A worktree of the project's repository, as a tool names it. */
export interface WorktreeTarget {
  /** The project's folder in that worktree (the same folder of the repository as the project's own). */
  root: string;
  branch?: string;
  /** The worktree is the project's own checkout. */
  own: boolean;
}

/**
 * Finds the worktree a tool names: its branch, the id of the task of the map that made it, or its folder (absolute, or
 * relative to the repository's top folder). Only worktrees of the project's own repository: anything else is refused.
 */
export function resolveWorktree(root: string, name: string): WorktreeTarget {
  const wanted = name.trim();
  if (!wanted) throw new Error("Name a worktree: its branch, its folder, or the id of the task that made it.");
  let listing: string;
  let top: string;
  let prefix: string;
  try {
    listing = git(root, ["worktree", "list", "--porcelain"]);
    top = git(root, ["rev-parse", "--show-toplevel"]);
    prefix = git(root, ["rev-parse", "--show-prefix"]);
  } catch {
    throw new Error("This project is not in a git repository: it has no worktrees.");
  }
  const worktrees: Array<{ path: string; branch?: string }> = [];
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) worktrees.push({ path: line.slice(9).trim() });
    else if (line.startsWith("branch refs/heads/") && worktrees.length) worktrees[worktrees.length - 1].branch = line.slice(18).trim();
  }
  const real = (folder: string) => {
    try {
      return fs.realpathSync.native(folder);
    } catch {
      return path.resolve(folder);
    }
  };
  const byTask = readRegistry(root).find((entry) => entry.task === wanted);
  const asFolder = real(path.resolve(top, wanted));
  const found =
    worktrees.find((worktree) => worktree.branch === wanted) ??
    (byTask ? worktrees.find((worktree) => real(worktree.path) === real(byTask.path)) : undefined) ??
    worktrees.find((worktree) => real(worktree.path) === asFolder);
  if (!found) {
    const names = worktrees.map((worktree) => worktree.branch ?? path.basename(worktree.path)).join(", ");
    throw new Error(`No worktree of this repository is "${wanted}". Its worktrees: ${names || "none"}.`);
  }
  const folder = path.join(found.path, prefix);
  return { root: folder, ...(found.branch ? { branch: found.branch } : {}), own: real(found.path) === real(top) };
}
