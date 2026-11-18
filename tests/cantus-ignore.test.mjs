import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, check } from "../dist/index.js";
import { ensureCantusIgnore, isRebuiltCantusFile } from "../dist/model/ignore.js";

function project() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-ignore-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/app.js"), "export const app = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  return { root, git };
}

test("the first analysis writes .cantus/.gitignore, so a git add -A leaves the cache out but keeps the map", () => {
  const { root, git } = project();
  analyze(root);
  assert.ok(fs.existsSync(path.join(root, ".cantus", "cache", "analysis.json")), "the cache was written");
  const ignore = fs.readFileSync(path.join(root, ".cantus", ".gitignore"), "utf8");
  assert.match(ignore, /^cache\/$/m);
  fs.writeFileSync(path.join(root, ".cantus", "model.json"), "{}\n");
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
  assert.ok(staged.includes(".cantus/model.json"), "the map is committed");
  assert.deepEqual(staged.filter((file) => file.startsWith(".cantus/cache") || file.endsWith(".log")), []);
});

test("an existing .cantus/.gitignore is the user's and is not changed", () => {
  const { root } = project();
  fs.mkdirSync(path.join(root, ".cantus"));
  fs.writeFileSync(path.join(root, ".cantus", ".gitignore"), "mine\n");
  ensureCantusIgnore(root);
  analyze(root);
  assert.equal(fs.readFileSync(path.join(root, ".cantus", ".gitignore"), "utf8"), "mine\n");
});

test("rebuilt files of .cantus are told apart from the map", () => {
  for (const file of [".cantus/cache/index.json", ".cantus/runs/ab.json", ".cantus/analysis.log", ".cantus/view.html"]) assert.ok(isRebuiltCantusFile(file), file);
  for (const file of [".cantus/model.json", ".cantus/.gitignore", "src/cache/x.json", "docs/analysis.log"]) assert.ok(!isRebuiltCantusFile(file), file);
});

test("a repository that already tracks the cache is told how to stop", () => {
  const { root, git } = project();
  fs.mkdirSync(path.join(root, ".cantus", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus", "cache", "index.json"), "{}");
  git("add", "-A", "-f");
  git("commit", "-q", "-m", "init");
  const analysis = analyze(root, { cache: false });
  assert.deepEqual(analysis.trackedRebuilt, [".cantus/cache/index.json"]);
  const finding = check(analysis).find((entry) => entry.kind === "tracked-cache");
  assert.ok(finding);
  assert.match(finding.message, /git rm -r --cached \.cantus\/cache/);
  assert.equal(finding.severity, "warning");

  git("rm", "-r", "-q", "--cached", ".cantus");
  git("commit", "-q", "-m", "untrack");
  assert.equal(check(analyze(root, { cache: false })).some((entry) => entry.kind === "tracked-cache"), false);
});
