import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const needsMarker = 'node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\') ? 0 : 1)"';
/** Fails with different words each time (a counter in a file), so no two failures look the same. */
const changingFailure = 'node -e "const fs=require(\'fs\');fs.appendFileSync(\'.count\',\'a\');console.log(\'failure \'+fs.readFileSync(\'.count\',\'utf8\').replace(/a/g,\'z\'));process.exit(1)"';
const sameFailure = 'node -e "console.log(\'expected 3, got 2\');process.exit(1)"';

function mappedShop({ git = false, agent } = {}) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  const model = shopModel();
  if (agent) model.agent = agent;
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  if (git) {
    fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/runs/\n.count\n");
    const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    run("add", "-A");
    run("commit", "-q", "-m", "init");
  }
  return root;
}

/** A scripted agent: `attempt(n, request)` returns the files session n writes; every session ends ok with `costUsd`. */
function agent(attempt, { costUsd } = {}) {
  const runs = [];
  const runner = (request) => {
    const n = runs.length + 1;
    runs.push(request);
    return {
      async setPermissionMode() {},
      [Symbol.asyncIterator]: async function* () {
        for (const [file, content] of Object.entries(attempt(n, request) ?? {})) {
          fs.mkdirSync(path.dirname(path.join(request.cwd, file)), { recursive: true });
          fs.writeFileSync(path.join(request.cwd, file), content);
        }
        yield { type: "result", ok: true, text: `attempt ${n}`, ...(costUsd !== undefined ? { costUsd } : {}) };
      },
    };
  };
  return { runner, runs };
}

const run = async (tasks, spec) => {
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", ...spec });
  await tasks.wait(task.id);
  return task;
};

test("a failed check sends the agent back with its output, and the task is done once the check passes", async () => {
  const { runner, runs } = agent((n) => (n === 2 ? { "marker.txt": "x\n" } : {}), { costUsd: 0.1 });
  const tasks = new TaskManager(new ProjectState(mappedShop()), runner);
  const task = await run(tasks, { gate: needsMarker });
  assert.equal(task.status, "done");
  assert.equal(runs.length, 2);
  assert.equal(task.attempts, 2);
  assert.equal(task.gate.passed, true);
  assert.equal(task.blockedBy, undefined);
  assert.equal(task.result, "attempt 2");
  assert.ok(Math.abs(task.costUsd - 0.2) < 1e-9, "the cost is every attempt's");
  const retry = runs[1].prompt;
  assert.ok(retry.startsWith(runs[0].prompt), "the new session gets the task as it was briefed");
  assert.match(retry, /This is attempt 2 of 3\./);
  assert.match(retry, /the check `node -e [^`]*` and it failed \(exit 1\)/);
  assert.match(retry, /Do not change the check, and do not skip, delete or weaken tests/);
  assert.match(retry, /`git status` and `git diff`/);
  assert.match(task.events.map((event) => event.text).join("\n"), /Attempt 2 of 3: the agent starts again in the same folder/);
  assert.equal(runs[1].cwd, runs[0].cwd);
  assert.equal(runs[1].permissionMode, "default");
});

test("attempts run out: blocked after the last one, with the count and the reason", async () => {
  const { runner, runs } = agent(() => ({}));
  const tasks = new TaskManager(new ProjectState(mappedShop()), runner);
  const task = await run(tasks, { gate: changingFailure });
  assert.equal(runs.length, 3, "one session and two retries by default");
  assert.equal(task.status, "blocked");
  assert.equal(task.attempts, 3);
  assert.equal(task.blockReason, "no attempts left");
  assert.match(task.error, /so the task is blocked after 3 attempts \(no attempts left\)\./);
  assert.match(runs[2].prompt, /This is attempt 3 of 3\./);
  assert.match(runs[2].prompt, /failure zz\n/, "each retry is told the latest output, not the first");
});

test("the same failure twice stops the retries", async () => {
  const { runner, runs } = agent(() => ({}));
  const tasks = new TaskManager(new ProjectState(mappedShop()), runner);
  const task = await run(tasks, { gate: sameFailure, retries: 5 });
  assert.equal(runs.length, 2, "the second attempt got nowhere, so there is no third");
  assert.equal(task.status, "blocked");
  assert.equal(task.blockReason, "the same failure twice");
  assert.match(task.error, /after 2 attempts \(the same failure twice\)/);
});

test("numbers in the output (times, counts) do not make two failures different", async () => {
  const { runner, runs } = agent(() => ({}));
  const tasks = new TaskManager(new ProjectState(mappedShop()), runner);
  const task = await run(tasks, { gate: 'node -e "console.log(\'3 failing in \'+Date.now()+\' ms\');process.exit(1)"', retries: 5 });
  assert.equal(runs.length, 2);
  assert.equal(task.blockReason, "the same failure twice");
});

test("the task's budget is shared by its attempts", async () => {
  const { runner, runs } = agent(() => ({}), { costUsd: 0.3 });
  const tasks = new TaskManager(new ProjectState(mappedShop()), runner);
  const task = await run(tasks, { gate: changingFailure, maxBudgetUsd: 0.5 });
  assert.deepEqual(runs.map((request) => request.maxBudgetUsd), [0.5, 0.2], "the retry gets what is left");
  assert.equal(runs.length, 2, "0.6 spent of 0.5: no third session");
  assert.equal(task.blockReason, "the task's budget is spent");
  assert.equal(task.status, "blocked");
});

test("retries: 0 gives one session; the map's agent.retries is the default; the number is capped at five", async () => {
  const none = agent(() => ({}));
  const single = await run(new TaskManager(new ProjectState(mappedShop()), none.runner), { gate: changingFailure, retries: 0 });
  assert.equal(none.runs.length, 1);
  assert.equal(single.status, "blocked");
  assert.equal(single.attempts, undefined);
  assert.doesNotMatch(single.error, /attempts/);

  const mapped = agent(() => ({}));
  await run(new TaskManager(new ProjectState(mappedShop({ agent: { retries: 1 } })), mapped.runner), { gate: changingFailure });
  assert.equal(mapped.runs.length, 2);
  const given = agent(() => ({}));
  await run(new TaskManager(new ProjectState(mappedShop({ agent: { retries: 1 } })), given.runner), { gate: changingFailure, retries: 3 });
  assert.equal(given.runs.length, 4, "the task's own number wins over the map's");

  const many = agent(() => ({}));
  await run(new TaskManager(new ProjectState(mappedShop()), many.runner), { gate: changingFailure, retries: 99 });
  assert.equal(many.runs.length, 6, "five retries at most");
});

test("a retry works in the same worktree, on top of what the first attempt committed, and a green one can be merged", async () => {
  const root = mappedShop({ git: true });
  const { runner, runs } = agent((n) => (n === 1 ? { "first.txt": "1\n" } : { "marker.txt": "x\n" }));
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = await run(tasks, { gate: needsMarker, isolation: "worktree" });
  assert.equal(task.status, "done");
  assert.equal(runs[1].cwd, runs[0].cwd);
  assert.equal(runs[1].cwd, task.worktree.path);
  assert.match(runs[1].prompt, new RegExp(`committed on the branch ${task.worktree.branch}`));
  assert.deepEqual(task.changedFiles.sort(), ["first.txt", "marker.txt"]);
  await tasks.merge(task.id);
  assert.equal(task.status, "merged");
  assert.ok(fs.existsSync(path.join(root, "first.txt")) && fs.existsSync(path.join(root, "marker.txt")));
});

test("a session that ends in error during a retry fails the task", async () => {
  let n = 0;
  const runner = () => ({
    async setPermissionMode() {},
    [Symbol.asyncIterator]: async function* () {
      n++;
      yield { type: "result", ok: n === 1, text: n === 1 ? "first" : "Ran out of turns." };
    },
  });
  const tasks = new TaskManager(new ProjectState(mappedShop()), runner);
  const task = await run(tasks, { gate: changingFailure });
  assert.equal(n, 2);
  assert.equal(task.status, "failed");
  assert.equal(task.result, "Ran out of turns.");
});
