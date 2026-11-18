import fs from "node:fs";
import path from "node:path";

/** Which checkout of the repository a project folder is in, when it is a linked worktree. */
export interface CheckoutInfo {
  /** The worktree's own folder name. */
  folder: string;
  /** The branch checked out, or the short commit when detached. */
  branch: string;
}

/**
 * Read from the files git keeps, with no process started: the map rebuilds its data after every change, and
 * the hooks look at this on each call. Undefined in the main checkout, outside git, and in a submodule.
 */
export function readWorktree(root: string): CheckoutInfo | undefined {
  try {
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      const dotGit = path.join(dir, ".git");
      if (fs.existsSync(dotGit)) {
        if (!fs.statSync(dotGit).isFile()) return undefined;
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!pointer) return undefined;
        const gitDir = path.resolve(dir, pointer);
        if (!/[\\/]worktrees[\\/][^\\/]+$/.test(gitDir)) return undefined;
        const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
        return { folder: path.basename(dir), branch: ref ?? head.slice(0, 7) };
      }
      if (path.dirname(dir) === dir) return undefined;
    }
  } catch {
    return undefined;
  }
}
