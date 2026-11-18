import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager, scanSourceFiles } from "../dist/index.js";
import { keepWorktreeOutOfGit, listFolders } from "../dist/run/worktree-rules.js";
import { locateFile } from "../dist/hooks/checkout.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function shop(ignore = ".cantus/cache/\n") {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ignore);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("a worktree inside .cantus is kept out of git by the repository's own exclude file, once", () => {
  const root = shop();
  const folder = path.join(root, ".cantus/worktrees/one");
  git(root, "worktree", "add", "-q", "-b", "one", folder);
  assert.match(git(root, "status", "--porcelain"), /\.cantus\/worktrees/, "untracked before");
  assert.equal(keepWorktreeOutOfGit(root, folder), true);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(keepWorktreeOutOfGit(root, folder), false, "the line is there already");
  assert.equal(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf8").split("/.cantus/worktrees/one/").length, 2);
  assert.equal(git(root, "worktree", "list").split("\n").length, 2, "git accepts it, and never prunes");
});

test("a folder outside the repository, or one git ignores already, is left alone", () => {
  const root = shop(".cantus/cache/\n.cantus/worktrees/\n");
  const inside = path.join(root, ".cantus/worktrees/two");
  git(root, "worktree", "add", "-q", "-b", "two", inside);
  assert.equal(keepWorktreeOutOfGit(root, inside), false);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-elsewhere`);
  git(root, "worktree", "add", "-q", "-b", "three", outside);
  assert.equal(keepWorktreeOutOfGit(root, outside), false);
});

test("the analysis does not scan the worktrees inside .cantus", () => {
  const root = shop();
  git(root, "worktree", "add", "-q", "-b", "four", path.join(root, ".cantus/worktrees/four"));
  const files = scanSourceFiles(root);
  assert.ok(files.length > 0);
  assert.equal(files.filter((file) => file.startsWith(".cantus/")).length, 0);
});

test("a file in a worktree under .cantus/worktrees belongs to that checkout, not to the project", () => {
  const root = shop();
  const folder = path.join(root, ".cantus/worktrees/five");
  git(root, "worktree", "add", "-q", "-b", "five", folder);
  const located = locateFile(root, path.join(folder, "src/pricing/index.ts"));
  assert.deepEqual({ other: located.other, relative: located.relative }, { other: true, relative: "src/pricing/index.ts" });
  assert.equal(fs.realpathSync(located.base), fs.realpathSync(folder));
});

test("the folder picker lists folders only, and writes the rule relative to the repository", () => {
  const root = shop();
  fs.mkdirSync(path.join(root, ".cantus/worktrees"), { recursive: true });
  const top = listFolders(root);
  assert.equal(top.rule, ".");
  assert.ok(top.folders.includes("src") && !top.folders.includes(".git"));
  assert.ok(!top.folders.some((name) => name.endsWith(".json")), "no files");
  const inner = listFolders(root, path.join(root, ".cantus"));
  assert.equal(inner.rule, ".cantus");
  assert.ok(inner.folders.includes("worktrees"));
  assert.equal(inner.parent, root);
  assert.equal(listFolders(root, "src").rule, "src");
  assert.equal(listFolders(root, "..").rule, "..");
  assert.throws(() => listFolders(root, "nope-nothing-here"), /Cannot read/);
});

test("a task for my own session lands in .cantus/worktrees and the main checkout stays clean", async () => {
  const root = shop();
  const tasks = new TaskManager(new ProjectState(root), () => { throw new Error("no agent"); });
  const task = tasks.prepare({ block: "src-pricing", prompt: "Add VAT" });
  for (let i = 0; i < 1000 && !task.finishedAt; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(fs.realpathSync(task.worktree.path), fs.realpathSync(path.join(root, ".cantus/worktrees/add-vat")));
  assert.doesNotMatch(git(root, "status", "--porcelain"), /worktrees/);
});

test("the system's folder dialog: one command per platform, and a machine without one falls back", async () => {
  const { folderDialogCommand, pickFolderNative } = await import("../dist/run/worktree-rules.js");
  assert.match(folderDialogCommand("win32", "C:\\it's")[0].args.at(-1), /FolderBrowserDialog[^]*SelectedPath = 'C:\\it''s'/);
  assert.equal(folderDialogCommand("darwin", "/tmp")[0].file, "osascript");
  assert.deepEqual(folderDialogCommand("linux", "/tmp").map((c) => c.file), ["zenity", "kdialog"]);
  const none = await pickFolderNative("/tmp", "linux");
  assert.ok("unavailable" in none || "cancelled" in none || "path" in none);
});
