import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const pass = 'node -e "process.exit(0)"';
const fail = 'node -e "console.log(\'expected 3, got 2\'); process.exit(1)"';
const needsMarker = 'node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\') ? 0 : 1)"';

function mappedShop({ git = false, verifyCommand } = {}) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  const model = shopModel();
  if (verifyCommand) model.agent = { verifyCommand };
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  if (git) {
    fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/runs/\n");
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

/** An agent that writes `files` in its folder and ends as `ok`. */
function agent({ ok = true, files = { "marker.txt": "x\n" }, text = "All tests pass." } = {}) {
  const cwds = [];
  const runner = (request) => ({
    async setPermissionMode() {},
    [Symbol.asyncIterator]: async function* () {
      cwds.push(request.cwd);
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(request.cwd, file)), { recursive: true });
        fs.writeFileSync(path.join(request.cwd, file), content);
      }
      yield { type: "result", ok, text };
    },
  });
  return { runner, cwds };
}

async function finished(tasks, task) {
  return tasks.wait(task.id);
}

test("the check is run by Cantus: exit code 0 makes the task done, with the result kept in the record", async () => {
  const root = mappedShop();
  const tasks = new TaskManager(new ProjectState(root), agent().runner);
  const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", gate: pass });
  await finished(tasks, task);
  assert.equal(task.status, "done");
  assert.equal(task.gate.passed, true);
  assert.equal(task.gate.exitCode, 0);
  assert.equal(task.gate.command, pass);
  assert.match(task.events.map((event) => event.text).join("\n"), /The check passed/);
  assert.equal(task.blockedBy, undefined);
});

test("an agent that says the tests pass does not make the task done: a failing check blocks it", async () => {
  const root = mappedShop();
  const tasks = new TaskManager(new ProjectState(root), agent({ text: "Done, all tests pass." }).runner);
  const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", gate: fail, retries: 0 });
  await finished(tasks, task);
  assert.equal(task.status, "blocked");
  assert.equal(task.blockedBy, "gate");
  assert.equal(task.gate.passed, false);
  assert.equal(task.gate.exitCode, 1);
  assert.match(task.gate.output, /expected 3, got 2/);
  assert.match(task.error, /failed \(exit 1\), so the task is blocked/);
  assert.match(task.events.find((event) => event.kind === "error").text, /expected 3, got 2/, "the end of the output is in the log");
  assert.equal(task.result, "Done, all tests pass.", "what the agent said is kept, next to what the check found");
  const saved = JSON.parse(fs.readFileSync(path.join(root, ".cantus/runs", `${task.id}.json`), "utf8"));
  assert.equal(saved.status, "blocked");
  assert.equal(saved.gate.exitCode, 1);
});

test("the check runs in the folder the agent worked in", async () => {
  const root = mappedShop({ git: true });
  const { runner, cwds } = agent();
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", isolation: "worktree", gate: needsMarker });
  await finished(tasks, task);
  assert.equal(task.status, "done", "marker.txt exists in the worktree, not in the project folder");
  assert.equal(fs.existsSync(path.join(root, "marker.txt")), false);
  assert.equal(cwds[0], task.worktree.path);
});

test("a blocked worktree task keeps its work on the branch, cannot be merged, and can be discarded", async () => {
  const root = mappedShop({ git: true });
  const tasks = new TaskManager(new ProjectState(root), agent().runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add a marker", mode: "edit", isolation: "worktree", gate: fail, retries: 0 });
  await finished(tasks, task);
  assert.equal(task.status, "blocked");
  assert.deepEqual(task.changedFiles, ["marker.txt"], "committed before the check, so nothing is lost");
  assert.match(tasks.diff(task.id), /\+x/);
  await assert.rejects(tasks.merge(task.id), /The task is blocked, not done/);
  assert.equal(fs.existsSync(path.join(root, "marker.txt")), false);
  await tasks.discard(task.id);
  assert.equal(task.status, "discarded");
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" }), /cantus\/task-/);
});

test("the map's verify command is the default check, and gate: false turns it off", async () => {
  const root = mappedShop({ verifyCommand: fail });
  const tasks = new TaskManager(new ProjectState(root), agent().runner);
  const checked = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", retries: 0 });
  await finished(tasks, checked);
  assert.equal(checked.status, "blocked");
  assert.equal(checked.gate.command, fail);
  const unchecked = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", gate: false });
  await finished(tasks, unchecked);
  assert.equal(unchecked.status, "done");
  assert.equal(unchecked.gate, undefined);
  const explicit = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", gate: pass });
  await finished(tasks, explicit);
  assert.equal(explicit.status, "done", "a command given for the task wins over the map's");
});

test("without a check a task is done when the agent is, as before", async () => {
  const tasks = new TaskManager(new ProjectState(mappedShop()), agent().runner);
  const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit" });
  await finished(tasks, task);
  assert.equal(task.status, "done");
  assert.equal(task.gate, undefined);
});

test("a session that ends in error is failed, and the check is not run", async () => {
  const tasks = new TaskManager(new ProjectState(mappedShop()), agent({ ok: false, text: "Ran out of turns." }).runner);
  const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", gate: pass });
  await finished(tasks, task);
  assert.equal(task.status, "failed");
  assert.equal(task.gate, undefined);
});

test("a check that cannot start or times out blocks the task rather than passing it", async () => {
  const tasks = new TaskManager(new ProjectState(mappedShop()), agent().runner);
  const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", gate: "cantus-no-such-command-xyz", retries: 0 });
  await finished(tasks, task);
  assert.equal(task.status, "blocked");
  assert.notEqual(task.gate.exitCode, 0);
});

test("a task stopped while its check runs ends as stopped", async () => {
  const tasks = new TaskManager(new ProjectState(mappedShop()), agent().runner);
  const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", gate: 'node -e "setTimeout(() => {}, 60000)"' });
  for (let i = 0; i < 500 && !task.events.some((event) => /Running the check/.test(event.text)); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  tasks.stop(task.id);
  await finished(tasks, task);
  assert.equal(task.status, "stopped");
  assert.equal(task.gate, undefined);
});

test("a request cannot choose the command Cantus runs as the check", async (t) => {
  const root = mappedShop();
  const { runner } = agent();
  const server = await startMapServer(new ProjectState(root), { port: 0, runner });
  t.after(() => server.close());
  const created = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/api/tasks", headers: { "x-cantus-token": server.token, "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ block: "src-pricing", prompt: "x", mode: "edit", gate: "node -e \"require('fs').writeFileSync('pwned.txt','x')\"" }));
  });
  assert.equal(created.status, 201);
  for (let i = 0; i < 300; i++) {
    const done = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, { headers: { "x-cantus-token": server.token } }).then((res) => res.json()).catch(() => []);
    if (done.some((task) => task.id === created.body.id && task.status === "done")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(path.join(root, "pwned.txt")), false);
  assert.equal(created.body.gate, undefined);
});

test("a declared ignored input changed after the gate blocks the worktree merge", async () => {
  const root = mappedShop({ git: true });
  const mapPath = path.join(root, ".cantus/model.json");
  const model = shopModel();
  model.agent = { gateInputs: ["local-check.txt"] };
  fs.writeFileSync(mapPath, JSON.stringify(model));
  fs.appendFileSync(path.join(root, ".gitignore"), "local-check.txt\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "Declare the ignored check input"], { cwd: root });
  const { runner, cwds } = agent({ files: { "marker.txt": "x\n", "local-check.txt": "one\n" } });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add a marker", mode: "edit", isolation: "worktree", gate: pass });
  await finished(tasks, task);
  assert.equal(task.status, "done");
  assert.deepEqual(task.gate.proof.dirty, []);
  const input = path.join(cwds[0], "local-check.txt");
  fs.writeFileSync(input, "two\n");
  await assert.rejects(tasks.merge(task.id), /candidate changed since its gate/);
  assert.equal(fs.existsSync(path.join(root, "marker.txt")), false);
  assert.equal(fs.readFileSync(input, "utf8"), "two\n");
});
