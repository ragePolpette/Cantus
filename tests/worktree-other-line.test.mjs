import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { worktreeOverview } from "../dist/run/worktrees.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The repository's old `main`, a line of work `line` thousands of commits on (the main checkout is on it), and a worktree Cantus made on that line. */
function repository() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-line-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "a.txt"), "0\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "old main");
  const oldMain = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "line");
  for (let index = 1; index <= 6; index++) {
    fs.writeFileSync(path.join(root, "a.txt"), `${index}\n`);
    git(root, "commit", "-qam", `line ${index}`);
  }
  const worktree = `${root}-task`;
  git(root, "worktree", "add", "-q", "-b", "cantus/task-1", worktree, "line");
  fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "the task's work");
  return { root, worktree, oldMain };
}

test("a worktree Cantus made on the line of work is compared with that line, not with the old main it was recorded from", () => {
  const { root, worktree, oldMain } = repository();
  const made = [{ path: worktree, branch: "cantus/task-1", base: oldMain, baseLabel: "main", task: "1", session: false, prompt: "A task", createdAt: new Date().toISOString() }];
  const overview = worktreeOverview(root, [], undefined, made);
  const found = overview.worktrees.find((entry) => entry.branch === "cantus/task-1");
  assert.equal(found.ahead, 1, "its one commit, not the six of the line it sits on");
  assert.equal(found.comparedWith, "line");
  assert.deepEqual(found.files, ["b.txt"]);
});

test("a worktree made from the old main with its own work keeps that base", () => {
  const { root, oldMain } = repository();
  const other = `${root}-old`;
  git(root, "worktree", "add", "-q", "-b", "cantus/task-2", other, "main");
  fs.writeFileSync(path.join(other, "c.txt"), "c\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "from old main");
  const made = [{ path: other, branch: "cantus/task-2", base: oldMain, baseLabel: "main", task: "2", session: false, prompt: "A task", createdAt: new Date().toISOString() }];
  const found = worktreeOverview(root, [], undefined, made).worktrees.find((entry) => entry.branch === "cantus/task-2");
  assert.equal(found.ahead, 1);
  assert.equal(found.comparedWith, undefined, "the overview's own base is not repeated");
});
