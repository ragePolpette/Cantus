import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Where a file the agent touches lives, in terms of the project the hooks were started for. */
export interface Located {
  /** The folder the file's project path is relative to: the project root, or the root of another checkout of it. */
  base: string;
  /** Project-relative, with forward slashes. */
  relative: string;
  /** The file is in another checkout (a worktree) of the same repository, not in `root`. */
  other: boolean;
}

/** Claude Code's own (`.claude/worktrees/<name>`) and the ones Cantus makes for a session (`.cantus/worktrees/<name>`), inside the project. */
const NESTED_WORKTREE = /^\.(?:claude|cantus)\/worktrees\/[^/]+\//;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function existingDir(file: string): string | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // not made yet (a file about to be written)
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Claude Code keeps `CLAUDE_PROJECT_DIR` on the folder the session started in, also when an agent works in a
 * worktree (a specialist with `isolation: "worktree"`, a session that enters one, the desktop app's): the hook
 * then gets paths in the worktree, not in the project. This tells a file there from one that belongs to no project.
 * Undefined when the file is in neither the project nor another checkout of its repository.
 */
export function locateFile(root: string, absolute: string): Located | undefined {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  const nested = NESTED_WORKTREE.exec(relative);
  if (nested) return { base: path.join(root, nested[0]), relative: relative.slice(nested[0].length), other: true };
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return { base: root, relative, other: false };
  try {
    const dir = existingDir(absolute);
    if (!dir) return undefined;
    const common = (from: string) => fs.realpathSync.native(path.resolve(from, git(from, ["rev-parse", "--git-common-dir"])));
    if (common(dir) !== common(root)) return undefined;
    // The project may be a folder of the repository: the same folder of the other checkout is its root.
    const base = path.join(git(dir, ["rev-parse", "--show-toplevel"]), git(root, ["rev-parse", "--show-prefix"]));
    const inside = path.relative(base, absolute).split(path.sep).join("/");
    if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
    return { base: path.normalize(base), relative: inside, other: fs.realpathSync.native(base) !== fs.realpathSync.native(root) };
  } catch {
    return undefined;
  }
}
