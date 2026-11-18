import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager } from "../dist/index.js";
import { ensureCantusIgnore } from "../dist/model/ignore.js";
import { copyFixture, shopModel } from "./helpers.mjs";

function gitShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  // Not the project's `.gitignore` of the Cantus rules: like a project that has never been analyzed by Cantus before the task.
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { root, git };
}

// A real agent's session runs Cantus's hooks and MCP server in the worktree, and they write `.cantus/.gitignore` there; the
// main checkout writes its own the first time it analyzes. The task's commit must not carry it, or the merge stops.
test("the .cantus/.gitignore that Cantus writes in a task's worktree stays out of its commit, and the merge goes through", async () => {
  const { root, git } = gitShop();
  const project = new ProjectState(root);
  project.get(); // analysis in the main checkout: writes its .cantus/.gitignore, untracked
  ensureCantusIgnore(root);
  assert.ok(fs.existsSync(path.join(root, ".cantus/.gitignore")));
  assert.equal(git("ls-files", ".cantus/.gitignore").trim(), "", "untracked in the main checkout");
  const runner = (request) => ({
    async setPermissionMode() {},
    [Symbol.asyncIterator]: async function* () {
      ensureCantusIgnore(request.cwd);
      fs.mkdirSync(path.join(request.cwd, "src/pricing"), { recursive: true });
      fs.writeFileSync(path.join(request.cwd, "src/pricing/vat.txt"), "vat\n");
      yield { type: "result", ok: true, text: "done" };
    },
  });
  const tasks = new TaskManager(project, runner);
  const record = tasks.start({ blocks: ["src-pricing"], prompt: "Add VAT.", mode: "edit", isolation: "worktree", gate: false });
  const done = await tasks.wait(record.id);
  assert.equal(done.status, "done", done.error);
  assert.deepEqual(done.changedFiles, ["src/pricing/vat.txt"], "only the agent's work is committed");
  await tasks.merge(done.id);
  // con core.autocrlf=true (Windows) git riscrive i fine riga: si confronta il contenuto, non i byte
  assert.equal(fs.readFileSync(path.join(root, "src/pricing/vat.txt"), "utf8").replace(/\r\n/g, "\n"), "vat\n");
  assert.equal(git("ls-files", ".cantus/.gitignore").trim(), "", "still not tracked");
});
