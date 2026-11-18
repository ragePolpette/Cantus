import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, handleHook, writeProjectIndex } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The shop as a git repository: a committed project, indexed, and a worktree in each place Claude Code makes one. */
function shopWithWorktrees(prefix = "") {
  const repo = copyFixture("shop");
  const root = prefix ? path.join(repo, prefix) : repo;
  if (prefix) {
    fs.mkdirSync(root);
    for (const entry of fs.readdirSync(repo)) if (entry !== prefix) fs.renameSync(path.join(repo, entry), path.join(root, entry));
  }
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "shop");
  writeProjectIndex(root, analyze(root, { model: shopModel(), skipGit: true }));
  const nested = path.join(repo, ".claude/worktrees/spec1");
  const sibling = path.join(path.dirname(repo), `${path.basename(repo)}-sibling`);
  git(repo, "worktree", "add", "-q", nested, "-b", "spec1");
  git(repo, "worktree", "add", "-q", sibling, "-b", "sibling");
  return { repo, root, nested: path.join(nested, prefix), sibling: path.join(sibling, prefix) };
}

const edit = (root, cwd, file, extra = {}) => ({ cwd, session_id: "s1", tool_name: "Edit", tool_input: { file_path: file }, ...extra });

test("a specialist in a worktree under .claude/worktrees: callers, and one note that the tools read another folder", () => {
  const { root, nested } = shopWithWorktrees();
  const file = path.join(nested, "src/orders/index.ts");
  const first = handleHook("pre-edit", edit(root, nested, file), root).hookSpecificOutput.additionalContext;
  assert.match(first, /another checkout of this repository/);
  assert.match(first, /- createOrder ← src\/checkout\/index\.ts:11/, "the file is judged by its place in the project, not 'outside every block'");
  const again = handleHook("pre-edit", edit(root, nested, path.join(nested, "src/orders/index.ts")), root);
  assert.equal(again, undefined, "said once per session");
  const other = handleHook("pre-edit", edit(root, nested, path.join(nested, "src/pricing/index.ts")), root);
  assert.doesNotMatch(other?.hookSpecificOutput.additionalContext ?? "", /another checkout/, "the checkout note is not repeated for the next file");
  const next = handleHook("pre-edit", { ...edit(root, nested, file), session_id: "s2" }, root).hookSpecificOutput.additionalContext;
  assert.match(next, /another checkout/, "a new session hears it again");
});

test("a sibling worktree and a project inside a repository folder are located too", () => {
  const { root, sibling } = shopWithWorktrees("app");
  const out = handleHook("pre-edit", edit(root, sibling, path.join(sibling, "src/orders/index.ts")), root).hookSpecificOutput.additionalContext;
  assert.match(out, /another checkout/);
  assert.match(out, /- createOrder ← src\/checkout\/index\.ts:11/);
  const outside = handleHook("pre-edit", edit(root, sibling, path.join(path.dirname(sibling), "README.md")), root);
  assert.equal(outside, undefined);
});

test("files that belong to no checkout of the project stay unknown", () => {
  const { root } = shopWithWorktrees();
  const stranger = copyFixture("shop");
  assert.equal(handleHook("pre-edit", edit(root, stranger, path.join(stranger, "src/orders/index.ts")), root), undefined);
  assert.equal(handleHook("pre-edit", edit(root, root, "/etc/passwd"), root), undefined);
});

test("after an edit in a worktree: the removed export is judged against the worktree's own file", () => {
  const { root, nested } = shopWithWorktrees();
  const file = path.join(nested, "src/orders/index.ts");
  fs.writeFileSync(file, "export interface Order { id: string; total: number }\n");
  const out = handleHook("post-edit", edit(root, nested, file), root).hookSpecificOutput.additionalContext;
  assert.match(out, /- createOrder is no longer exported, but other blocks use it: src\/checkout\/index\.ts:11/);
  assert.equal(handleHook("post-edit", edit(root, root, path.join(root, "src/orders/index.ts")), root), undefined, "the project's own file is unchanged");
});
