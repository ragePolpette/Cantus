import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PlanRunner, PlanStore, ProjectState, TaskManager, autonomousPolicy, formatElapsed, orderPlan, readPlan, renderPlanText } from "../dist/index.js";
import { registerWorktree } from "../dist/run/worktree-registry.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const green = 'node -e "process.exit(0)"';

function gitShop({ agent } = {}) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), ...(agent ? { agent } : {}) }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/runs/\n");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return root;
}

/** A scripted agent: `work(taskId, request)` returns the files the task writes. It sees the prompt, so it knows which task it is. */
function agent(work = (id) => ({ [`src/pricing/${id}.txt`]: `${id}\n` }), { costUsd } = {}) {
  const seen = [];
  const runner = (request) => {
    const id = /the task "([a-z0-9-]+)"/.exec(request.prompt)?.[1] ?? "none";
    const entry = { id, request, sawBefore: fs.readdirSync(path.join(request.cwd, "src/pricing")) };
    seen.push(entry);
    return {
      async setPermissionMode() {},
      [Symbol.asyncIterator]: async function* () {
        for (const [file, content] of Object.entries(work(id, request, seen) ?? {})) {
          fs.mkdirSync(path.dirname(path.join(request.cwd, file)), { recursive: true });
          fs.writeFileSync(path.join(request.cwd, file), content);
        }
        yield { type: "result", ok: true, text: `did ${id}`, ...(costUsd !== undefined ? { costUsd } : {}) };
      },
    };
  };
  return { runner, seen };
}

const task = (id, blocks, extra = {}) => ({ id, blocks, prompt: `Do ${id}.`, ...extra });
const planOf = (tasks, extra = {}) => ({ goal: "Add VAT everywhere", tasks, ...extra });

function setup({ agent: agentOptions, ...rest } = {}) {
  const root = gitShop(agentOptions ? { agent: agentOptions } : {});
  const project = new ProjectState(root);
  const store = new PlanStore(root);
  const make = (runner) => {
    const tasks = new TaskManager(project, runner);
    return { tasks, runner: new PlanRunner(project, tasks, store) };
  };
  return { root, project, store, make, ...rest };
}

const read = (project, raw) => {
  const { analysis, model } = project.get();
  return readPlan(raw, analysis, model);
};

test("a plan is read against the map: ids, blocks, checks by name, dependencies, size", () => {
  const { project } = setup({ agent: { checks: { unit: green } } });
  const errors = (raw) => read(project, raw).check.errors.join("\n");
  assert.deepEqual(read(project, planOf([task("pricing", ["src-pricing"], { check: "unit" })])).check.errors, []);
  assert.match(errors("nope"), /A plan is an object/);
  assert.match(errors({ tasks: [task("a", ["src-pricing"])] }), /needs a goal/);
  assert.match(errors(planOf([])), /at least one task/);
  assert.match(errors(planOf([task("a", ["src-nope"])])), /no block "src-nope" on the map/);
  assert.match(errors(planOf([task("a", ["src-pricing"]), task("a", ["src-db"])])), /the id is used twice/);
  assert.match(errors(planOf([task("Bad Id", ["src-pricing"])])), /lowercase letters, digits and dashes/);
  assert.match(errors(planOf([{ id: "a", blocks: ["src-pricing"], prompt: "" }])), /needs a prompt/);
  assert.match(errors(planOf([task("a", ["src-pricing"], { prompt: "x".repeat(8001) })])), /over 8000 characters/);
  assert.match(errors(planOf([task("a", ["src-pricing"], { check: "rm -rf ." })])), /no check "rm -rf \." in the map \(agent\.checks has: unit\)\. A plan names a check; it never carries a command/);
  assert.match(errors(planOf([task("a", ["src-pricing"], { dependsOn: ["ghost"] })])), /"ghost", which is not a task/);
  assert.match(errors(planOf([task("a", ["src-pricing"], { dependsOn: ["b"] }), task("b", ["src-db"], { dependsOn: ["a"] })])), /make a cycle: a → b → a|make a cycle: b → a → b/);
  assert.match(errors(planOf([task("a", ["src-pricing"], { model: "rm -rf" })])), /not a model name/);
  assert.match(errors(planOf([task("a", ["src-pricing"], { retries: 9 })])), /retries must be a whole number from 0 to 5/);
  assert.match(errors(planOf([task("a", ["src-pricing"])], { budgetUsd: -1 })), /budgetUsd must be a positive number/);
  assert.match(errors(planOf(Array.from({ length: 31 }, (_, i) => task(`t${i}`, ["src-pricing"])))), /at most 30 tasks/);
  assert.equal(read(project, planOf([task("none", ["src-pricing"], { check: "none" })])).check.errors.length, 0, "none is a name too");
});

test("the order comes from the map: providers first, whatever order the plan is written in", () => {
  const { project } = setup();
  const { analysis, model } = project.get();
  const plan = planOf([task("web", ["src-web"]), task("checkout", ["src-checkout"]), task("orders", ["src-orders"]), task("db", ["src-db"]), task("pricing", ["src-pricing"])]);
  const order = orderPlan(plan, analysis, model);
  assert.equal(order.cycle, undefined);
  const at = (id) => order.order.indexOf(id);
  assert.ok(at("db") < at("orders") && at("orders") < at("checkout") && at("pricing") < at("checkout") && at("checkout") < at("web"), order.order.join(", "));
  assert.deepEqual(order.waves[0].sort(), ["db", "pricing"], "independent tasks share a wave");
  assert.ok(order.implicit.added.some(([after, before]) => after === "orders" && before === "db"));
  assert.deepEqual(orderPlan({ tasks: plan.tasks.map((t) => ({ ...t, dependsOn: undefined })).slice(0, 1) }, analysis, model).order, ["web"]);
  // The plan's own dependency wins over the map's when they clash, and says so.
  const clash = planOf([task("db", ["src-db"], { dependsOn: ["orders"] }), task("orders", ["src-orders"])]);
  const result = orderPlan(clash, analysis, model);
  assert.deepEqual(result.order, ["orders", "db"]);
  assert.deepEqual(result.implicit.skipped, [["orders", "db"]]);
  assert.match(read(project, clash).check.warnings.join("\n"), /the order you gave is kept/);
});

test("plans and their state are files; nothing runs until a person approves this revision", async () => {
  const { root, project, store, make } = setup();
  const { plan: read1 } = read(project, planOf([task("pricing", ["src-pricing"])]));
  const plan = store.add(read1, { kind: "agent", session: "abc" });
  assert.match(plan.id, /^\d{4}-[0-9a-f]{6}$/);
  assert.equal(plan.revision, 1);
  assert.equal(store.get(plan.id).author.session, "abc");
  assert.equal(store.state(plan.id).status, "draft");
  assert.deepEqual(store.list().map((entry) => entry.plan.id), [plan.id]);
  assert.ok(fs.existsSync(path.join(root, ".cantus/runs/plans", `${plan.id}.json`)) && fs.existsSync(path.join(root, ".cantus/runs/plans", `${plan.id}.state.json`)), "the plan and the state are two files");
  assert.throws(() => store.get("../etc/passwd"), /not a plan id/);
  const { runner: planRunner } = make(agent().runner);
  await assert.rejects(planRunner.run(plan.id), /not approved/);
  planRunner.approve(plan.id);
  assert.equal(store.state(plan.id).status, "approved");
  // A change to the plan (a new revision) takes the approval away.
  fs.writeFileSync(path.join(root, ".cantus/runs/plans", `${plan.id}.json`), JSON.stringify({ ...plan, revision: 2 }));
  await assert.rejects(planRunner.run(plan.id), /not approved/);
});

test("an approved plan runs task by task in the map's order: each in its own worktree from where the project is now, merged before the next", async () => {
  const { root, project, store, make } = setup();
  const raw = planOf([task("orders", ["src-orders"]), task("db", ["src-db"]), task("pricing", ["src-pricing"])]);
  const plan = store.add(read(project, raw).plan, { kind: "person" });
  const { runner: scripted, seen } = agent((id) => ({ [`src/pricing/${id}.txt`]: `${id}\n` }), { costUsd: 0.1 });
  const { runner: planRunner } = make(scripted);
  planRunner.approve(plan.id);
  const log = [];
  const state = await planRunner.run(plan.id, { log: (line) => log.push(line) });
  assert.equal(state.status, "finished", JSON.stringify(state.blockedBy));
  assert.deepEqual(seen.map((entry) => entry.id).slice(0, 1), ["db"], "the provider goes first");
  assert.equal(seen.length, 3);
  const [first, , third] = seen;
  assert.deepEqual(first.sawBefore.filter((f) => f.endsWith(".txt")), [], "the first task starts from the project as it is");
  assert.ok(seen[1].sawBefore.includes(`${first.id}.txt`) || seen[1].id === "pricing", "a later task starts after the merge of the earlier ones");
  assert.ok(third.sawBefore.includes(`${first.id}.txt`) && third.sawBefore.includes(`${seen[1].id}.txt`), `the last one sees both: ${third.sawBefore}`);
  for (const entry of seen) assert.notEqual(entry.request.cwd, root, "never the project folder");
  for (const id of ["db", "orders", "pricing"]) assert.ok(fs.existsSync(path.join(root, `src/pricing/${id}.txt`)), `${id} is merged into the project`);
  assert.deepEqual(Object.values(state.tasks).map((entry) => entry.status), ["merged", "merged", "merged"]);
  assert.ok(Math.abs(state.costUsd - 0.3) < 1e-9);
  assert.ok(state.elapsedMs > 0, "the time of the sessions is counted");
  assert.ok(Object.values(state.tasks).every((entry) => entry.elapsedMs > 0 && entry.elapsedMs <= state.elapsedMs), "each task has its time, within the plan's");
  assert.match(renderPlanText(store.get(plan.id), state, orderPlan(plan, project.get().analysis, project.get().model)), /of work/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".cantus/runs/plans", `${plan.id}.state.json`), "utf8")).status, "finished", "the state is on disk");
  assert.match(execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" }), /Merge branch 'cantus\/task-/);
  assert.equal(execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).trim().split("\n").length, 1, "the worktrees are gone");
  assert.match(seen[0].request.prompt, /whose goal is: Add VAT everywhere/);
  assert.match(renderPlanText(store.get(plan.id), state, orderPlan(plan, project.get().analysis, project.get().model)), /Status: finished, approved/);
  assert.ok(log.some((line) => /starting "db"/.test(line)));
  assert.equal((await planRunner.run(plan.id)).status, "finished", "running a finished plan does nothing");
  assert.equal(seen.length, 3);
});

test("the plan stops at the first task that is not done, says why, and picks up from there", async () => {
  const { root, project, store, make } = setup({ agent: { checks: { fixed: 'node -e "process.exit(require(\'fs\').existsSync(\'src/pricing/orders.txt\') ? 0 : 1)"' } } });
  const raw = planOf([task("db", ["src-db"]), task("orders", ["src-orders"], { check: "fixed", retries: 0 }), task("checkout", ["src-checkout"])]);
  const plan = store.add(read(project, raw).plan, { kind: "person" });
  let attempt = 0;
  const { runner: scripted, seen } = agent((id) => {
    if (id === "orders" && ++attempt === 1) return { "src/pricing/wrong.txt": "x\n" }; // the first attempt does something, but not the file the check wants
    return { [`src/pricing/${id}.txt`]: `${id}\n` };
  });
  const { runner: planRunner } = make(scripted);
  planRunner.approve(plan.id);
  const first = await planRunner.run(plan.id);
  assert.equal(first.status, "blocked");
  assert.equal(first.blockedBy.task, "orders");
  assert.match(first.blockedBy.why, /the task is blocked/);
  assert.deepEqual([first.tasks.db.status, first.tasks.orders.status, first.tasks.checkout.status], ["merged", "blocked", "pending"]);
  assert.equal(seen.some((entry) => entry.id === "checkout"), false, "nothing after the blocked task starts");
  assert.ok(first.tasks.orders.branch);
  const log = [];
  const second = await planRunner.run(plan.id, { log: (line) => log.push(line) });
  assert.equal(second.status, "finished", JSON.stringify(second.blockedBy));
  assert.deepEqual(seen.filter((entry) => entry.id === "db").length, 1, "what is merged does not run again");
  assert.ok(log.some((line) => /earlier attempt of "orders" stays on/.test(line)));
  assert.equal(second.blockedBy, undefined);
  assert.ok(fs.existsSync(path.join(root, "src/pricing/checkout.txt")));
});

test("a task cut short by a restart leaves its worktree and branch: they go, and the task starts over", async () => {
  const { root, project, store, make } = setup();
  const plan = store.add(read(project, planOf([task("pricing", ["src-pricing"])])).plan, { kind: "person" });
  // What a process that died mid-task leaves: a registered worktree on a branch, and a state that says running.
  const leftoverPath = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-leftover-")), "wt");
  execFileSync("git", ["worktree", "add", "-q", "-b", "cantus/task-dead0001", leftoverPath], { cwd: root });
  registerWorktree(root, { path: leftoverPath, branch: "cantus/task-dead0001", base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), task: "dead0001", session: false, prompt: "x", createdAt: new Date().toISOString() });
  store.writeState({ ...store.state(plan.id), status: "running", approvedRevision: 1, tasks: { pricing: { status: "running", task: "dead0001", branch: "cantus/task-dead0001" } } });
  const { runner: scripted, seen } = agent();
  const { runner: planRunner } = make(scripted);
  const log = [];
  const state = await planRunner.run(plan.id, { log: (line) => log.push(line) });
  assert.equal(state.status, "finished", JSON.stringify(state.blockedBy));
  assert.equal(seen.length, 1);
  assert.equal(fs.existsSync(leftoverPath), false);
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" }), /dead0001/);
  assert.ok(log.some((line) => /Removed what the earlier attempt left \(cantus\/task-dead0001: it had changed nothing\)/.test(line)));
});

test("a stopped task that changed nothing leaves no worktree behind when the plan picks up again", async () => {
  const { root, project, store, make } = setup();
  const plan = store.add(read(project, planOf([task("db", ["src-db"])])).plan, { kind: "person" });
  let started = false;
  let first = true;
  const slowOnce = (request) => ({
    async setPermissionMode() {},
    [Symbol.asyncIterator]: async function* () {
      if (first) {
        first = false;
        await new Promise((resolve) => {
          started = true;
          request.abort.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "result", ok: false, text: "stopped" };
        return;
      }
      fs.writeFileSync(path.join(request.cwd, "src/pricing/db.txt"), "db\n");
      yield { type: "result", ok: true, text: "done" };
    },
  });
  const { runner: planRunner, tasks } = make(slowOnce);
  planRunner.approve(plan.id);
  const running = planRunner.run(plan.id);
  for (let i = 0; i < 500 && !started; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(started, "the agent started");
  planRunner.stop();
  const stopped = await running;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.tasks.db.status, "stopped");
  const log = [];
  const second = await planRunner.run(plan.id, { log: (line) => log.push(line) });
  assert.equal(second.status, "finished", JSON.stringify(second.blockedBy));
  assert.ok(log.some((line) => /Removed what the earlier attempt left \(cantus\/task-.*: it had changed nothing\)/.test(line)), log.join("\n"));
  assert.equal(log.some((line) => /stays on/.test(line)), false);
  assert.doesNotMatch(execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }), /cantus\/task-/, "no worktree of Cantus is left");
});

test("after a merge the task's check runs again on the merged result, and a red one stops the plan", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-counter-"));
  const counter = path.join(dir, "runs");
  // Green in the worktree (first run), red on the merged result (second run).
  fs.writeFileSync(path.join(dir, "once.cjs"), `const fs=require("fs");const p=${JSON.stringify(counter)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;fs.writeFileSync(p,String(n+1));console.log("run "+n);process.exit(n===0?0:1);`);
  const check = `node ${JSON.stringify(path.join(dir, "once.cjs"))}`;
  const { root, project, store, make } = setup({ agent: { checks: { once: check } } });
  const plan = store.add(read(project, planOf([task("pricing", ["src-pricing"], { check: "once" }), task("db", ["src-db"])])).plan, { kind: "person" });
  const { runner: scripted, seen } = agent();
  const { runner: planRunner } = make(scripted);
  planRunner.approve(plan.id);
  const state = await planRunner.run(plan.id);
  assert.equal(state.status, "blocked");
  assert.equal(state.blockedBy.task, "pricing");
  assert.match(state.blockedBy.why, /fails on the merged result \(exit 1\); the merge is in the branch/);
  assert.equal(state.tasks.pricing.status, "merged");
  assert.equal(seen.some((entry) => entry.id === "db"), false);
  assert.ok(fs.existsSync(path.join(root, "src/pricing/pricing.txt")), "the merge stays: the person decides what to do with it");
});

test("the plan's budget is shared by its tasks, and no task starts once it is spent", async () => {
  const { project, store, make } = setup();
  const plan = store.add(read(project, planOf([task("db", ["src-db"]), task("orders", ["src-orders"]), task("checkout", ["src-checkout"])], { budgetUsd: 0.07 })).plan, { kind: "person" });
  const { runner: scripted, seen } = agent(undefined, { costUsd: 0.04 });
  const { runner: planRunner } = make(scripted);
  planRunner.approve(plan.id);
  const state = await planRunner.run(plan.id);
  assert.deepEqual(seen.map((entry) => entry.request.maxBudgetUsd), [0.07, 0.03], "each task gets what is left");
  assert.equal(seen.length, 2);
  assert.equal(state.status, "blocked");
  assert.deepEqual(state.blockedBy.task, "checkout");
  assert.match(state.blockedBy.why, /the plan's budget is spent \(\$0\.08 of \$0\.07\)/);
});

test("a task's own model, budget, retries and the check named in the plan reach the task; check none turns the check off", async () => {
  const { project, store, make } = setup({ agent: { verifyCommand: 'node -e "process.exit(1)"', checks: { unit: green } } });
  const plan = store.add(read(project, planOf([task("db", ["src-db"], { check: "unit", model: "haiku", budgetUsd: 0.5, retries: 1 }), task("orders", ["src-orders"], { check: "none" }), task("pricing", ["src-pricing"], { retries: 0, dependsOn: ["db", "orders"] })])).plan, { kind: "person" });
  const { runner: scripted, seen } = agent();
  const { runner: planRunner } = make(scripted);
  planRunner.approve(plan.id);
  const state = await planRunner.run(plan.id);
  const byId = Object.fromEntries(seen.map((entry) => [entry.id, entry.request]));
  assert.equal(byId.db.model, "haiku");
  assert.equal(byId.db.maxBudgetUsd, 0.5);
  assert.equal(state.tasks.db.status, "merged", "the named check passed");
  assert.equal(state.tasks.orders.status, "merged", "no check: done when the agent is");
  assert.equal(state.tasks.pricing.status, "blocked", "the map's verify command applies when the task names none");
  assert.equal(state.status, "blocked");
});

test("stopping a plan stops the task in progress and nothing else starts", async () => {
  const { project, store, make } = setup();
  const plan = store.add(read(project, planOf([task("db", ["src-db"]), task("orders", ["src-orders"])])).plan, { kind: "person" });
  let release;
  const slow = (request) => ({
    async setPermissionMode() {},
    [Symbol.asyncIterator]: async function* () {
      request.abort.signal.addEventListener("abort", () => release?.(), { once: true });
      await new Promise((resolve) => (release = resolve));
      yield { type: "result", ok: false, text: "stopped" };
    },
  });
  const { runner: planRunner, tasks } = make(slow);
  planRunner.approve(plan.id);
  const running = planRunner.run(plan.id);
  for (let i = 0; i < 300 && !tasks.list().length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  planRunner.stop();
  const state = await running;
  assert.equal(state.status, "stopped");
  assert.equal(tasks.list().length, 1);
  assert.equal(state.tasks.orders.status, "pending");
});

test("the policy of an unattended plan allows each check of the plan, and only those", () => {
  const policy = autonomousPolicy({ verifyCommand: () => ["npm test", "npm run lint"] });
  const ask = (command) => policy({ kind: "tool", tool: "Bash", input: { command }, id: "1", summary: "", createdAt: "" }, { scope: { blocks: [] } });
  assert.deepEqual(ask("npm test"), { allow: true });
  assert.deepEqual(ask("npm run lint -- --fix"), { allow: true });
  assert.equal(ask("npm run build").allow, false);
  assert.match(ask("npm run build").message, /`npm test` or `npm run lint`/);
  assert.equal(ask("npm test && rm -rf .").allow, false);
});

test("CLI: cantus plan add / list / show / run", () => {
  const { root } = setup();
  const file = path.join(path.dirname(root), `plan-${path.basename(root)}.json`);
  fs.writeFileSync(file, JSON.stringify(planOf([task("orders", ["src-orders"]), task("db", ["src-db"])])));
  const runnerFile = path.join(path.dirname(root), `runner-${path.basename(root)}.mjs`);
  fs.writeFileSync(runnerFile, `import fs from "node:fs";\nimport path from "node:path";\nexport default (request) => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: async function* () { const id = /the task "([a-z0-9-]+)"/.exec(request.prompt)[1]; fs.writeFileSync(path.join(request.cwd, "src/pricing", id + ".txt"), id); yield { type: "result", ok: true, text: "ok" }; } });\n`);
  const run = (...args) => spawnSync(process.execPath, [cli, "plan", ...args, "-C", root], { encoding: "utf8" });
  const bad = run("add", file.replace(".json", "-missing.json"));
  assert.notEqual(bad.status, 0);
  const wrong = path.join(path.dirname(root), `wrong-${path.basename(root)}.json`);
  fs.writeFileSync(wrong, JSON.stringify(planOf([task("a", ["src-nope"], { check: "rm -rf ." })])));
  const rejected = run("add", wrong);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /no block "src-nope" on the map/);
  const added = run("add", file);
  assert.equal(added.status, 0, added.stderr);
  const id = /Plan (\d{4}-[0-9a-f]{6}):/.exec(added.stdout)[1];
  assert.match(added.stdout, /db .*\n.*\n?.*orders .*after db \(from the map\)/s);
  assert.match(run("list").stdout, new RegExp(`${id} +draft +0/2 merged`));
  assert.match(run("show", id).stdout, /Status: draft, not approved/);
  const refused = run("run", id);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /not approved\. Add --yes/);
  const ran = run("run", id, "--yes", "--runner", runnerFile);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /Status: finished, approved/);
  assert.ok(fs.existsSync(path.join(root, "src/pricing/db.txt")) && fs.existsSync(path.join(root, "src/pricing/orders.txt")));
  assert.match(run("list").stdout, new RegExp(`${id} +finished +2/2 merged`));
});

test("an ignored input changed by the integration check blocks the plan even on exit zero", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-gate-input-"));
  const script = path.join(dir, "check.cjs");
  const { root, project, store, make } = setup({ agent: {
    checks: { local: `node "${script}"` },
    gateInputs: ["local-check.txt"],
  } });
  fs.writeFileSync(script, `const fs = require("node:fs"); if (process.cwd() === ${JSON.stringify(root)}) fs.writeFileSync("local-check.txt", "after");`);
  fs.appendFileSync(path.join(root, ".gitignore"), "local-check.txt\n");
  fs.writeFileSync(path.join(root, "local-check.txt"), "before");
  execFileSync("git", ["add", ".gitignore"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "Ignore the local check input"], { cwd: root });
  const plan = store.add(read(project, planOf([task("pricing", ["src-pricing"], { check: "local" })])).plan, { kind: "person" });
  const { runner } = make(agent().runner);
  runner.approve(plan.id);
  const state = await runner.run(plan.id);
  assert.equal(state.status, "blocked");
  assert.equal(state.tasks.pricing.status, "merged");
  assert.equal(state.tasks.pricing.integration.passed, false);
  assert.match(state.blockedBy.why, /content changed during the check/);
});

test("elapsed time reads as seconds, minutes or hours", () => {
  assert.equal(formatElapsed(45_000), "45 s");
  assert.equal(formatElapsed(192_000), "3 min 12 s");
  assert.equal(formatElapsed(3_900_000), "1 h 05 min");
  assert.equal(formatElapsed(0), "0 s");
});
