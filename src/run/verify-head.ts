import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MODEL_DIR } from "../model/index.js";
import { gitCommonDir } from "../state/peers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Runs `work` in a temporary checkout of `ref` (a branch, a tag or a commit), so that a branch can be verified without
 * the person having it checked out or a worktree for it. The checkout is detached, made next to the repository's own data
 * and removed afterwards; the map's file and the records of the run are carried between it and the project.
 * Dependencies are not installed there: the caller decides about the tests.
 */
export async function withCheckout<T>(root: string, ref: string, work: (folder: string) => Promise<T>): Promise<T> {
  if (ref.startsWith("-")) throw new Error(`"${ref}" is not a commit, branch or tag.`);
  let commit: string;
  let prefix: string;
  try {
    commit = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
    prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    throw new Error(`--head "${ref}" is not a branch, tag or commit of this repository.`);
  }
  const common = gitCommonDir(root);
  if (!common) throw new Error("--head needs a git repository.");
  const top = path.join(common, "cantus-verify", `${commit.slice(0, 10)}-${process.pid}`);
  fs.mkdirSync(path.dirname(top), { recursive: true });
  git(root, ["worktree", "add", "--detach", "--quiet", top, commit]);
  const project = path.join(top, prefix);
  try {
    // The map is often not committed on the branch under review: the project's own is used.
    const model = path.join(project, MODEL_DIR, "model.json");
    const own = path.join(root, MODEL_DIR, "model.json");
    if (!fs.existsSync(model) && fs.existsSync(own)) {
      fs.mkdirSync(path.dirname(model), { recursive: true });
      fs.copyFileSync(own, model);
    }
    return await work(project);
  } finally {
    // The run's record is kept: the report names it.
    try {
      const runs = path.join(project, MODEL_DIR, "runs");
      if (fs.existsSync(runs)) fs.cpSync(runs, path.join(root, MODEL_DIR, "runs"), { recursive: true });
    } catch {
      // nothing to keep
    }
    try {
      git(root, ["worktree", "remove", "--force", top]);
    } catch {
      fs.rmSync(top, { recursive: true, force: true });
      try {
        git(root, ["worktree", "prune"]);
      } catch {
        // gone with the folder
      }
    }
  }
}
