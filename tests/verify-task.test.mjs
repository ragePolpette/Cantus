import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

function shop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/runs/\n");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return { root, run };
}

const REPORT = "```json\n" + JSON.stringify({ verdict: "issues", summary: "The discount is not used.", checked: ["read cart.ts"], findings: [{ severity: "major", title: "Discount never applied", detail: "checkout ignores it", file: "src/checkout/cart.ts", line: 3, evidence: "no caller", suggestion: "use it" }] }) + "\n```";

/** The worker writes its files and reports; the reviewer (no edit tools) records what it was given and answers with REPORT. */
function agents() {
  const reviews = [];
  const runner = (request) => ({
    async setPermissionMode() {},
    [Symbol.asyncIterator]: async function* () {
      if (request.disallowedTools?.includes("Edit")) {
        reviews.push({ cwd: request.cwd, prompt: request.prompt });
        yield { type: "result", ok: true, text: REPORT, costUsd: 0.05 };
        return;
      }
      fs.appendFileSync(path.join(request.cwd, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
      yield { type: "result", ok: true, text: "I added a 10% discount to the cart." };
    },
  });
  return { runner, reviews };
}

test("a finished in-place task is verified against where the project stood when it started, with its prompt and its report", async () => {
  const { root } = shop();
  // Work of the person, uncommitted, from before the task: it stays in the comparison, marked as not the task's.
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const mine = 1;\n");
  const { runner, reviews } = agents();
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-checkout", prompt: "Add a discount to the cart", mode: "edit", gate: false });
  await tasks.wait(task.id);
  assert.equal(task.status, "done", task.error);
  assert.ok(task.startedFrom.commit, "the start is recorded");
  assert.deepEqual(task.startedFrom.dirty, ["src/pricing/index.ts"]);

  const verification = tasks.verifyTask(task.id, { tests: false });
  assert.equal(verification.verifies, task.id);
  assert.deepEqual(task.verifiedBy, [verification.id]);
  await tasks.wait(verification.id);
  assert.equal(verification.status, "done", verification.error);
  assert.equal(verification.verification.review.findings.length, 1);
  assert.equal(reviews[0].cwd, root);
  assert.match(reviews[0].prompt, /Add a discount to the cart/, "the task's prompt is the intent");
  assert.match(reviews[0].prompt, /I added a 10% discount/, "its report is a claim to check");
  assert.match(reviews[0].prompt, /src\/checkout\/cart\.ts/);
  assert.equal(verification.verification.base.commit, task.startedFrom.commit);

  assert.throws(() => tasks.verifyTask(verification.id), /That is a verification/);
  assert.throws(() => tasks.verifyTask("nope"), /No task/);
});

test("a worktree task is verified in its worktree, before it is merged; after the merge it is refused with the way to do it", async () => {
  const { root } = shop();
  const { runner, reviews } = agents();
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ orchestrate: true, prompt: "Find and fix the discount bug", mode: "edit", isolation: "worktree", gate: false });
  await tasks.wait(task.id);
  assert.equal(task.status, "done", task.error);
  assert.equal(fs.readFileSync(path.join(root, "src/checkout/cart.ts"), "utf8").includes("discount"), false, "the work is only in the worktree");

  const verification = tasks.verifyTask(task.id, { tests: false });
  await tasks.wait(verification.id);
  assert.equal(verification.status, "done", verification.error);
  assert.equal(reviews[0].cwd, task.worktree.path, "the reviewer looks at the worktree");
  assert.match(reviews[0].prompt, /src\/checkout\/cart\.ts/, "it sees the task's commit on the branch");
  assert.equal(verification.verification.base.commit, task.worktree.base);

  await tasks.merge(task.id);
  assert.throws(() => tasks.verifyTask(task.id), /already merged/);
});
