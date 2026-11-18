import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

/** The commit a name stands for (a branch, a tag, a short hash, `HEAD~3`), or an error that says so. */
export function resolveRef(root: string, ref: string): string {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`"${ref}" is not a commit of this repository.`);
  }
}

/** The branch changes are usually compared with: origin's default, else main or master. */
export function defaultBase(root: string): string | undefined {
  const candidates: string[] = [];
  try {
    candidates.push(git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim());
  } catch {
    // no remote HEAD
  }
  candidates.push("origin/main", "origin/master", "main", "master");
  return candidates.find((candidate) => {
    try {
      resolveRef(root, candidate);
      return true;
    } catch {
      return false;
    }
  });
}

/** Where two commits diverged; when they share no history, the first one itself. */
export function mergeBase(root: string, base: string, head: string): string {
  try {
    return git(root, ["merge-base", base, head]).trim() || resolveRef(root, base);
  } catch {
    return resolveRef(root, base);
  }
}

/** Writes the project as it was at a commit into an empty folder. The repository itself is not touched. */
export function exportRef(root: string, commit: string, dir: string): void {
  const prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
  const tree = prefix ? `${commit}:${prefix}` : commit;
  try {
    git(root, ["rev-parse", "--verify", "--quiet", tree]);
  } catch {
    throw new Error(`This folder did not exist at ${commit.slice(0, 7)}: there is nothing to compare with.`);
  }
  // tar gets a relative name: GNU tar reads "C:\…" as a remote host.
  // From the top of the repository: inside a subfolder, git archive keeps only that folder's path of the tree.
  const top = git(root, ["rev-parse", "--show-toplevel"]).trim();
  const archive = path.join(dir, ".cantus-ref.tar");
  execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, tree], { windowsHide: true, cwd: top, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", ".cantus-ref.tar"], { windowsHide: true, cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  fs.rmSync(archive, { force: true });
}

/** Runs `use` on a copy of the project at a commit, then deletes the copy. */
export function withCommit<T>(root: string, commit: string, use: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-ref-"));
  try {
    exportRef(root, commit, dir);
    return use(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
