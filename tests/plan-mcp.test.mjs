import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PlanRunner, PlanStore, ProjectState, TaskManager } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const green = 'node -e "process.exit(0)"';
const red = 'node -e "process.exit(1)"';

function gitShop(agent) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), agent }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/runs/\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

async function connect(t, root) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--no-ui", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
  return { client, call };
}

const task = (id, blocks, extra = {}) => ({ id, blocks, prompt: `Do ${id}.`, ...extra });

test("plan_propose stores a plan as an agent's, not approved, with the order from the map; the boss cannot run or approve it", async (t) => {
  const root = gitShop({ checks: { unit: green } });
  const { client, call } = await connect(t, root);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const forbidden of ["plan_run", "plan_approve", "plan_accept", "plan_merge", "plan_discard"]) assert.equal(names.includes(forbidden), false, forbidden);
  const proposed = await call("plan_propose", { goal: "Add VAT", tasks: [task("checkout", ["src-checkout"], { check: "unit" }), task("pricing", ["src-pricing"], { check: "unit" })] });
  assert.equal(proposed.isError, false, proposed.text);
  assert.match(proposed.text, /NOT approved/);
  assert.match(proposed.text, /cantus plan run /);
  const store = new PlanStore(root);
  const [{ plan, state }] = store.list();
  assert.deepEqual(plan.author, { kind: "agent" });
  assert.equal(state.status, "draft");
  assert.equal(state.approvedRevision, undefined, "nothing is approved by the agent");
  const status = await call("plan_status", { id: plan.id });
  assert.match(status.text, /Wave 1[\s\S]*pricing[\s\S]*Wave 2[\s\S]*checkout/, "providers first");
  assert.match((await call("plan_status")).text, new RegExp(`${plan.id}  draft, not approved`));
});

test("plan_propose refuses what readPlan refuses, a command in place of a check name, and a flood of unapproved plans", async (t) => {
  const root = gitShop({ checks: { unit: green } });
  const { call } = await connect(t, root);
  const bad = await call("plan_propose", { goal: "x", tasks: [task("a", ["src-ghost"])] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /no block "src-ghost"/);
  const command = await call("plan_propose", { goal: "x", tasks: [task("a", ["src-pricing"], { check: "rm -rf /" })] });
  assert.equal(command.isError, true);
  assert.match(command.text, /never carries a command/);
  assert.equal(new PlanStore(root).list().length, 0, "nothing stored");
  for (let i = 0; i < 10; i++) assert.equal((await call("plan_propose", { goal: `g${i}`, tasks: [task("a", ["src-pricing"])] })).isError, false);
  const flood = await call("plan_propose", { goal: "one more", tasks: [task("a", ["src-pricing"])] });
  assert.equal(flood.isError, true);
  assert.match(flood.text, /already 10 plans/);
});

test("replaces revises a plan that has not started (the approval starts over) and refuses one that has", async (t) => {
  const root = gitShop({ checks: { unit: green } });
  const { call } = await connect(t, root);
  await call("plan_propose", { goal: "first", tasks: [task("a", ["src-pricing"])] });
  const store = new PlanStore(root);
  const id = store.list()[0].plan.id;
  const state = store.state(id);
  state.approvedRevision = 1;
  state.status = "approved";
  store.writeState(state);
  const revised = await call("plan_propose", { goal: "second", tasks: [task("a", ["src-pricing"]), task("b", ["src-db"])], replaces: id });
  assert.equal(revised.isError, false, revised.text);
  assert.match(revised.text, /revision 2/);
  assert.equal(store.get(id).goal, "second");
  assert.equal(store.state(id).status, "draft");
  assert.notEqual(store.state(id).approvedRevision, store.get(id).revision, "a person approves the new text");
  assert.equal(store.list().length, 1, "same plan, not a second one");
  const started = store.state(id);
  started.tasks.a.status = "merged";
  store.writeState(started);
  const refused = await call("plan_propose", { goal: "third", tasks: [task("a", ["src-pricing"])], replaces: id });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /has started: propose a new plan/);
});

test("task_retry adds words to a task that stopped, sent with its next attempt; it takes no check, scope, limit or tries; a running or merged task refuses", async (t) => {
  const root = gitShop({ checks: { red, unit: green } });
  const project = new ProjectState(root);
  const store = new PlanStore(root);
  const { readPlan } = await import("../dist/index.js");
  const { analysis, model } = project.get();
  const { plan: read } = readPlan({ goal: "g", tasks: [{ id: "pricing", blocks: ["src-pricing"], prompt: "Do pricing.", check: "red", retries: 0 }] }, analysis, model);
  const plan = store.add(read, { kind: "agent" });
  const seen = [];
  const runner = (request) => {
    seen.push(request.prompt);
    return { async setPermissionMode() {}, [Symbol.asyncIterator]: async function* () { yield { type: "result", ok: true, text: "did it" }; } };
  };
  const planRunner = new PlanRunner(project, new TaskManager(project, runner), store);
  planRunner.approve(plan.id);
  const { client, call } = await connect(t, root);
  const schema = (await client.listTools()).tools.find((tool) => tool.name === "task_retry").inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["instructions", "plan", "task"], "words only: nothing that changes the gate");
  const before = await call("task_retry", { plan: plan.id, task: "pricing", instructions: "Use the existing rounding helper." });
  assert.equal(before.isError, true, "the task has not stopped yet");
  assert.match(before.text, /pending/);
  assert.equal((await planRunner.run(plan.id)).status, "blocked");
  const added = await call("task_retry", { plan: plan.id, task: "pricing", instructions: "Use the existing rounding helper." });
  assert.equal(added.isError, false, added.text);
  assert.equal(store.state(plan.id).tasks.pricing.instructions[0], "Use the existing rounding helper.");
  assert.match((await call("plan_status", { id: plan.id })).text, /\+ Use the existing rounding helper\./);
  assert.equal(store.get(plan.id).tasks[0].check, "red", "the check is the plan's, untouched");
  assert.equal(store.get(plan.id).revision, 1, "no new revision: the approval holds");
  await planRunner.run(plan.id);
  assert.match(seen[seen.length - 1], /Added after the task stopped[\s\S]*- Use the existing rounding helper\./);
  assert.doesNotMatch(seen[0], /Added after the task stopped/);
  const long = await call("task_retry", { plan: plan.id, task: "pricing", instructions: "x".repeat(1501) });
  assert.equal(long.isError, true);
  for (let i = 0; i < 5; i++) await call("task_retry", { plan: plan.id, task: "pricing", instructions: `more ${i}` });
  assert.match((await call("task_retry", { plan: plan.id, task: "pricing", instructions: "one too many" })).text, /needs a person/);
  const state = store.state(plan.id);
  state.tasks.pricing.status = "merged";
  store.writeState(state);
  assert.match((await call("task_retry", { plan: plan.id, task: "pricing", instructions: "late" })).text, /is merged/);
  assert.match((await call("task_retry", { plan: plan.id, task: "ghost", instructions: "x" })).text, /no task "ghost"/);
});
