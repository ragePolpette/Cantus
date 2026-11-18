import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ProjectState, TaskManager, PlanStore, PlanRunner } from "../dist/index.js";
import { createCodexRunner } from "../dist/run/codex-runner.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
const source = "src/pricing/index.ts";

function setup(t, agent) {
  const root = copyFixture("shop");
  t.after(() => {
    for (const line of git(root, "worktree", "list", "--porcelain").split("\n")) {
      if (line.startsWith("worktree ") && line.slice(9) !== root) git(root, "worktree", "remove", "--force", line.slice(9));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), ...(agent ? { agent } : {}) }));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/runs/\n.cantus/*.log\n.cantus/integration-ready\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function runner(write, costUsd) {
  const requests = [];
  return { requests, run: request => {
    requests.push(request);
    return { async *[Symbol.asyncIterator]() {
      write(request, requests.length);
      yield { type: "result", ok: true, text: "done", ...(costUsd === undefined ? {} : { costUsd }) };
    } };
  } };
}

test("resume rechecks a failed integration gate without rerunning or remerging the domain task", async t => {
  // A portable gate that passes in a linked worktree but fails in the main checkout until an external marker is set.
  const gate = 'node -e "const fs=require(\'fs\');process.exit(fs.statSync(\'.git\').isDirectory()&&!fs.existsSync(\'.cantus/integration-ready\')?1:0)"';
  const root = setup(t, { verifyCommand: gate });
  const scripted = runner(req => fs.writeFileSync(path.join(req.cwd, source), "export const integrated = true;\n"));
  const make = () => {
    const project = new ProjectState(root);
    const store = new PlanStore(root);
    return { store, engine: new PlanRunner(project, new TaskManager(project, scripted.run), store) };
  };
  const { store, engine } = make();
  const plan = store.add({ goal: "integration recovery", tasks: [{ id: "pricing", blocks: ["src-pricing"], prompt: "Change pricing", retries: 0 }] }, { kind: "person" });
  engine.approve(plan.id);
  assert.equal((await engine.run(plan.id)).status, "blocked");
  const merged = git(root, "rev-parse", "HEAD");
  const resumed = await make().engine.run(plan.id);
  assert.equal(resumed.status, "blocked", "restart cannot bypass the failed gate");
  assert.equal(resumed.tasks.pricing.integration.passed, false);
  assert.match(resumed.blockedBy.why, /fails on the merged result/);
  assert.equal(scripted.requests.length, 1, "the domain task is already merged");
  assert.equal(git(root, "rev-parse", "HEAD"), merged, "no duplicate merge");
  const legacy = store.state(plan.id);
  delete legacy.tasks.pricing.integration;
  store.writeState(legacy);
  assert.equal((await make().engine.run(plan.id)).status, "blocked", "legacy merged states without a gate record are also checked");
  fs.writeFileSync(path.join(root, ".cantus/integration-ready"), "ready");
  const recovered = await make().engine.run(plan.id);
  assert.equal(recovered.status, "finished");
  assert.equal(recovered.tasks.pricing.integration.passed, true);
  assert.equal(recovered.tasks.pricing.integration.commit, merged);
  assert.equal(scripted.requests.length, 1);
});

for (const output of [source, "gate-output.txt", ".cantus/.gitignore"]) {
  test(`merge preserves edits to ${output} produced by a successful gate`, async t => {
    const root = setup(t);
    const scripted = runner(req => fs.writeFileSync(path.join(req.cwd, source), "export const checked = false;\n"));
    const gate = `node -e "require('fs').writeFileSync('${output}','export const checked = true;\\n')"`;
    const tasks = new TaskManager(new ProjectState(root), scripted.run);
    const task = tasks.start({ block: "src-pricing", prompt: "Change pricing", mode: "edit", isolation: "worktree", gate, retries: 0 });
    await tasks.wait(task.id);
    const head = git(root, "rev-parse", "HEAD");
    assert.equal(task.gate.passed, false);
    await assert.rejects(tasks.merge(task.id), /not done|not committed/);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(fs.readFileSync(path.join(task.worktree.path, output), "utf8"), "export const checked = true;\n");
    assert.notEqual(task.status, "merged");
  });
}

test("retry budget subtracts cumulative cost from the original total exactly once", async t => {
  const root = setup(t);
  const scripted = runner((req, n) => fs.writeFileSync(path.join(req.cwd, "failure.txt"), ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"][n - 1]), 0.1);
  const tasks = new TaskManager(new ProjectState(root), scripted.run);
  const gate = 'node -e "console.log(require(\'fs\').readFileSync(\'failure.txt\',\'utf8\'));process.exit(1)"';
  const task = tasks.start({ block: "src-pricing", prompt: "Change pricing", mode: "edit", gate, retries: 5, maxBudgetUsd: 1 });
  await tasks.wait(task.id);
  assert.deepEqual(scripted.requests.map(req => req.maxBudgetUsd), [1, 0.9, 0.8, 0.7, 0.6, 0.5]);
  assert.ok(Math.abs(task.costUsd - 0.6) < 1e-9);
  assert.equal(task.blockReason, "no attempts left");
});

test('a manual candidate commit cannot inherit an earlier successful gate', async t => {
 const root=setup(t);const scripted=runner(req=>fs.writeFileSync(path.join(req.cwd,source),'export const manual=false;\n'));
 const tasks=new TaskManager(new ProjectState(root),scripted.run);
 const task=tasks.start({block:'src-pricing',prompt:'candidate',mode:'edit',isolation:'worktree',gate:'node -e "process.exit(0)"',retries:0});
 await tasks.wait(task.id);assert.equal(task.gate.passed,true);
 fs.appendFileSync(path.join(task.worktree.path,source),'export const unverified=true;\n');
 git(task.worktree.path,'add','-A');git(task.worktree.path,'commit','-qm','manual change');
 await assert.rejects(tasks.merge(task.id),/candidate changed/);
 assert.ok(fs.existsSync(task.worktree.path));
});

test('ignored output survives a successful merge and is reported as deferred cleanup', async t => {
 const root=setup(t);fs.appendFileSync(path.join(root,'.gitignore'),'\nprivate-output.txt\n');git(root,'add','.gitignore');git(root,'commit','-qm','ignore local output');
 const scripted=runner(req=>{fs.writeFileSync(path.join(req.cwd,source),'export const integrated=true;\n');fs.writeFileSync(path.join(req.cwd,'private-output.txt'),'keep me');});
 const tasks=new TaskManager(new ProjectState(root),scripted.run);
 const task=tasks.start({block:'src-pricing',prompt:'preserve ignored data',mode:'edit',isolation:'worktree',retries:0});
 await tasks.wait(task.id);await tasks.merge(task.id);
 assert.equal(task.status,'merged');assert.match(task.cleanupError,/Ignored local files/);
 assert.equal(fs.readFileSync(path.join(task.worktree.path,'private-output.txt'),'utf8'),'keep me');
});

test('integration rejects a zero-exit gate that mutates uncommitted source', async t => {
 const gate=`node -e "const fs=require('fs');if(fs.statSync('.git').isDirectory())fs.appendFileSync('${source}','// changed by integration gate\\n')"`;
 const root=setup(t,{verifyCommand:gate});const scripted=runner(req=>fs.writeFileSync(path.join(req.cwd,source),'export const original=true;\n'));
 const project=new ProjectState(root);const store=new PlanStore(root);const engine=new PlanRunner(project,new TaskManager(project,scripted.run),store);
 const plan=store.add({goal:'exact content',tasks:[{id:'pricing',blocks:['src-pricing'],prompt:'change pricing',retries:0}]},{kind:'person'});engine.approve(plan.id);
 const state=await engine.run(plan.id);assert.equal(state.status,'blocked');assert.equal(state.tasks.pricing.integration.passed,false);
 assert.match(state.blockedBy.why,/content changed/);assert.match(fs.readFileSync(path.join(root,source),'utf8'),/changed by integration/);
});

test('resume reconciles a durable merge when plan persistence was interrupted', async t => {
 const root=setup(t,{verifyCommand:'node -e "process.exit(0)"'});const scripted=runner(req=>fs.writeFileSync(path.join(req.cwd,source),'export const recovered=true;\n'));
 const make=()=>{const p=new ProjectState(root);const store=new PlanStore(root);return {store,engine:new PlanRunner(p,new TaskManager(p,scripted.run),store)};};
 const {store,engine}=make();const plan=store.add({goal:'merge recovery',tasks:[{id:'pricing',blocks:['src-pricing'],prompt:'change',retries:0}]},{kind:'person'});engine.approve(plan.id);
 const completed=await engine.run(plan.id);const head=git(root,'rev-parse','HEAD');
 completed.status='running';completed.tasks.pricing.status='running';delete completed.tasks.pricing.integration;store.writeState(completed);
 const recovered=await make().engine.run(plan.id);assert.equal(recovered.status,'finished');assert.equal(scripted.requests.length,1);assert.equal(git(root,'rev-parse','HEAD'),head);
});

test("the Codex adapter runs the fixed domain, verification and correction cycle", async t => {
  const root = setup(t, { verifyCommand: 'node -e "process.exit(0)"' });
  const base = git(root, "rev-parse", "HEAD");
  const requests = [];
  const codex = createCodexRunner(async (_options, thread) => ({
    async runStreamed(prompt) {
      const cwd = thread.workingDirectory;
      const profile = thread.sandboxMode;
      requests.push({ cwd, profile });
      assert.equal(git(root, "rev-parse", "HEAD"), base, "destination must stay unchanged until approval");
      let answer = "Done";
      if (profile === "read-only") {
        const text = fs.readFileSync(path.join(cwd, source), "utf8");
        answer = JSON.stringify(text.includes("fixed")
          ? { verdict: "ok", summary: "Fixed", checked: [source], findings: [] }
          : { verdict: "issues", summary: "Incomplete", checked: [source], findings: [{ severity: "major", title: "Missing behavior", file: source, line: 1 }] });
      } else {
        const correction = prompt.includes("Missing behavior");
        fs.writeFileSync(path.join(cwd, source), correction ? "export const fixed = true;\n" : "export const pending = true;\n");
      }
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: `codex-test-${requests.length}` };
        yield { type: "item.completed", item: { type: "agent_message", text: answer } };
        yield { type: "turn.completed", usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 3 } };
      })() };
    },
  }));
  const project = new ProjectState(root);
  const store = new PlanStore(root);
  const tasks = new TaskManager(project, codex);
  const engine = new PlanRunner(project, tasks, store);
  const plan = store.add({ goal: "review the candidate", verify: true, tasks: [{ id: "pricing", blocks: ["src-pricing"], prompt: "Change pricing" }] }, { kind: "person" });
  engine.approve(plan.id);
  const state = await engine.run(plan.id);
  assert.equal(state.status, "finished", JSON.stringify(state.blockedBy));
  assert.deepEqual(requests.map(request => request.profile), ["workspace-write", "read-only", "workspace-write", "read-only"]);
  assert.equal(new Set(requests.map(request => request.cwd)).size, 1);
  const pricing = state.tasks.pricing;
  assert.equal(pricing.corrections, 1);
  assert.equal(pricing.candidateReviewed, true);
  assert.deepEqual(tasks.get(pricing.task).tokenUsage, { input: 60, cachedInput: 20, output: 6 });
  assert.deepEqual(tasks.get(pricing.verification.task).tokenUsage, { input: 30, cachedInput: 10, output: 3 });
  assert.match(fs.readFileSync(path.join(root, source), "utf8"), /fixed = true/);
});

test("merge preserves the candidate when the integration record cannot be written", async t => {
  const root = setup(t);
  const scripted = runner(req => fs.writeFileSync(path.join(req.cwd, source), "export const candidate = true;\n"));
  const tasks = new TaskManager(new ProjectState(root), scripted.run);
  const task = tasks.start({ block: "src-pricing", prompt: "Change pricing", mode: "edit", isolation: "worktree" });
  await tasks.wait(task.id);
  assert.equal(task.status, "done");
  const head = git(root, "rev-parse", "HEAD");
  const record = path.join(root, ".cantus", "runs", `${task.id}.json`);
  const contents = fs.readFileSync(record);
  fs.unlinkSync(record);
  fs.mkdirSync(record);

  await assert.rejects(tasks.merge(task.id), /Cannot record integration intent/);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(task.status, "done");
  assert.equal(fs.readFileSync(path.join(task.worktree.path, source), "utf8"), "export const candidate = true;\n");

  fs.rmdirSync(record);
  fs.writeFileSync(record, contents);
  await tasks.merge(task.id);
  assert.equal(task.status, "merged");
});

test("a malformed record does not prevent other worktrees from being restored", async t => {
  const root = setup(t);
  const scripted = runner(req => fs.writeFileSync(path.join(req.cwd, source), "export const candidate = true;\n"));
  const project = new ProjectState(root);
  const tasks = new TaskManager(project, scripted.run);
  const start = prompt => tasks.start({ block: "src-pricing", prompt, mode: "edit", isolation: "worktree" });
  const broken = start("First candidate");
  await tasks.wait(broken.id);
  const healthy = start("Second candidate");
  await tasks.wait(healthy.id);
  const record = path.join(root, ".cantus", "runs", `${broken.id}.json`);
  fs.writeFileSync(record, "{ truncated");

  const resumed = new TaskManager(project, scripted.run);
  assert.equal(resumed.get(healthy.id).status, "done");
  assert.ok(fs.existsSync(path.join(broken.worktree.path, source)));
});

test("cleanup preserves an ignored map copy when the agent changes it", async t => {
  const root = setup(t);
  const map = ".cantus/model.json";
  fs.appendFileSync(path.join(root, ".gitignore"), `/${map}\n`);
  git(root, "rm", "--cached", "--", map);
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "Keep the map local");

  const scripted = runner(req => {
    fs.writeFileSync(path.join(req.cwd, source), "export const candidate = true;\n");
    fs.appendFileSync(path.join(req.cwd, map), "\n");
  });
  const tasks = new TaskManager(new ProjectState(root), scripted.run);
  const task = tasks.start({ block: "src-pricing", prompt: "Change pricing", mode: "edit", isolation: "worktree" });
  await tasks.wait(task.id);
  await tasks.merge(task.id);

  assert.equal(task.status, "merged");
  assert.match(task.cleanupError, /Ignored local files.*model\.json/);
  assert.equal(fs.readFileSync(path.join(task.worktree.path, map), "utf8"), fs.readFileSync(path.join(root, map), "utf8") + "\n");
});
