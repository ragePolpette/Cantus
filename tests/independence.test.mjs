import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PlanRunner, PlanStore, ProjectState, TaskManager, independenceNotes, independentSessions, readPlan, renderPlanText, orderPlan } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const green = 'node -e "process.exit(0)"';

function gitShop(agent) {
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

/**
 * The workers: a task writes `src/pricing/<id>.txt`; a review (it cannot edit: its request lists the edit tools as
 * disallowed) answers with the next report of `reports`, or with a clean one when they are used up.
 */
function crew(reports = []) {
  const work = [];
  const reviews = [];
  const runner = (request) => {
    const isReview = (request.disallowedTools ?? []).includes("Edit");
    const id = /the task "([a-z0-9-]+)"/.exec(request.prompt)?.[1] ?? "none";
    if (isReview) reviews.push({ request });
    else work.push({ id, request });
    return {
      async setPermissionMode() {},
      [Symbol.asyncIterator]: async function* () {
        if (isReview) {
          const report = reports[reviews.length - 1] ?? { verdict: "ok", summary: "Nothing wrong.", checked: ["the diff"], findings: [] };
          if (report === "crash") {
            yield { type: "result", ok: false, text: "the reviewer crashed" };
            return;
          }
          yield { type: "result", ok: true, text: "```json\n" + JSON.stringify(report) + "\n```", costUsd: 0.02, model: request.model };
          return;
        }
        fs.mkdirSync(path.join(request.cwd, "src/pricing"), { recursive: true });
        fs.writeFileSync(path.join(request.cwd, `src/pricing/${id}.txt`), `${id}\n`);
        yield { type: "result", ok: true, text: `did ${id}`, costUsd: 0.01 };
      },
    };
  };
  return { runner, work, reviews };
}

const blocker = { verdict: "issues", summary: "The price is rounded the wrong way.", checked: ["the diff"], findings: [{ severity: "blocker", title: "Rounds down", detail: "Cents are cut, not rounded." }] };
const minor = { verdict: "issues", summary: "Small things.", checked: [], findings: [{ severity: "minor", title: "Naming" }] };
const task = (id, blocks, extra = {}) => ({ id, blocks, prompt: `Do ${id}.`, ...extra });
const planOf = (tasks, extra = {}) => ({ goal: "Add VAT everywhere", tasks, ...extra });

function setup(agent, reports) {
  const root = gitShop(agent);
  const project = new ProjectState(root);
  const store = new PlanStore(root);
  const { runner: agentRunner, work, reviews } = crew(reports);
  const tasks = new TaskManager(project, agentRunner);
  const runner = new PlanRunner(project, tasks, store);
  const add = (raw) => {
    const { analysis, model } = project.get();
    const { plan, check } = readPlan(raw, analysis, model);
    assert.deepEqual(check.errors, []);
    return store.add(plan, { kind: "agent", session: "boss-session-1" });
  };
  return { root, project, store, runner, add, work, reviews };
}

test("the plan file says which tasks get a separate review, and by which model; wrong values are refused", () => {
  const { project } = setup();
  const { analysis, model } = project.get();
  const errors = (raw) => readPlan(raw, analysis, model).check.errors.join("\n");
  assert.match(errors(planOf([task("a", ["src-pricing"], { verify: "yes" })])), /verify must be true or false/);
  assert.match(errors(planOf([task("a", ["src-pricing"], { verifyModel: "rm -rf /" })])), /not a model name for verifyModel/);
  assert.match(errors(planOf([task("a", ["src-pricing"])], { verify: 1 })), /verify must be true or false/);
  const ok = readPlan(planOf([task("a", ["src-pricing"], { verify: true, verifyModel: "opus" })], { verify: false, verifyModel: "haiku" }), analysis, model);
  assert.deepEqual(ok.check.errors, []);
  assert.equal(ok.plan.tasks[0].verifyModel, "opus");
  assert.equal(ok.plan.verifyModel, "haiku");
});

test("independence rules: the same model for the work and its review is found; no review is only a note when the map requires one", () => {
  const plan = (extra, tasks) => ({ ...planOf(tasks, extra) });
  // Nothing configured: both use Claude Code's default.
  assert.match(independenceNotes(plan({ verify: true }, [task("a", ["src-pricing"])]), undefined)[0], /"a" is built and reviewed by the same model \(Claude Code's default\).*only a warning/);
  // Another model for the reviewer: nothing to say.
  assert.deepEqual(independenceNotes(plan({ verify: true, verifyModel: "opus" }, [task("a", ["src-pricing"], { model: "sonnet" })]), undefined), []);
  // The map's own models count: block tasks on sonnet, verify on sonnet.
  const same = { agent: { models: { block: "sonnet", verify: "sonnet" } } };
  assert.equal(independenceNotes(plan({}, [task("a", ["src-pricing"], { verify: true })]), same).length, 1);
  assert.deepEqual(independenceNotes(plan({}, [task("a", ["src-pricing"], { verify: true, verifyModel: "opus" })]), same), []);
  // Not reviewed: silent by default (the check is Cantus's, not a model's), a finding under `require`.
  assert.deepEqual(independenceNotes(plan({}, [task("a", ["src-pricing"])]), undefined), []);
  assert.match(independenceNotes(plan({}, [task("a", ["src-pricing"])]), { agent: { independence: "require" } })[0], /no separate review/);
  // A task can opt out of a plan that reviews by default.
  assert.deepEqual(independenceNotes(plan({ verify: true, verifyModel: "opus" }, [task("a", ["src-pricing"], { verify: false, model: "opus" })]), undefined), []);
});

test("a reviewed plan: each merged task is reviewed by a session of its own, the roles are recorded, the same model is only a warning by default", async () => {
  const { runner, store, add, work, reviews } = setup({ checks: { unit: green } });
  const plan = add(planOf([task("db", ["src-db"], { check: "unit" }), task("pricing", ["src-pricing"], { verify: false })], { verify: true }));
  runner.approve(plan.id);
  const log = [];
  const state = await runner.run(plan.id, { log: (line) => log.push(line) });
  assert.equal(state.status, "finished", JSON.stringify(state.blockedBy));
  assert.equal(work.length, 2);
  assert.equal(reviews.length, 1, "only the task that is reviewed has a review");
  assert.ok(log.some((line) => /built and reviewed by the same model/.test(line)));
  assert.equal(state.independence.length, 1, "a warning kept in the state: the task 'pricing' opted out");
  const db = state.tasks.db;
  assert.equal(db.verification.verdict, "ok");
  assert.equal(db.roles.planner.session, "boss-session-1");
  assert.equal(db.roles.gate.command, green);
  assert.ok(db.roles.executor.task && db.roles.verifier.task && db.roles.executor.task !== db.roles.verifier.task);
  assert.equal(independentSessions(db.roles), true);
  assert.equal(independentSessions({ ...db.roles, verifier: { task: db.roles.planner.session } }), false, "the reviewer cannot be the planner's session");
  assert.equal(independentSessions({ ...db.roles, verifier: { task: db.roles.executor.task } }), false, "nor the one that did the work");
  assert.equal(state.tasks.pricing.verification, undefined);
  // The reviewer started from the commit before the merge, with the claim to check and the task's own words.
  const review = reviews[0].request;
  assert.match(review.prompt, /did db/);
  assert.match(review.prompt, /Do db\./);
  assert.match(renderPlanText(store.get(plan.id), state, orderPlan(plan, { dependencies: [] }, undefined)), /reviewed \(ok\)/);
});

test("with agent.independence require, a plan whose work and review would share a model does not start", async () => {
  const { runner, add, work, reviews } = setup({ independence: "require" });
  const plan = add(planOf([task("db", ["src-db"])], { verify: true }));
  runner.approve(plan.id);
  const state = await runner.run(plan.id);
  assert.equal(state.status, "blocked");
  assert.match(state.blockedBy.why, /agent\.independence is "require"/);
  assert.match(state.blockedBy.why, /same model/);
  assert.equal(work.length + reviews.length, 0, "nothing was started");
  // With another model for the reviewer it goes.
  const other = setup({ independence: "require", model: "sonnet" });
  const planB = other.add(planOf([task("db", ["src-db"])], { verify: true, verifyModel: "opus" }));
  other.runner.approve(planB.id);
  const stateB = await other.runner.run(planB.id);
  assert.equal(stateB.status, "finished", JSON.stringify(stateB.blockedBy));
  assert.equal(other.reviews[0].request.model, "opus");
  assert.equal(other.work[0].request.model, "sonnet");
  // And `require` also asks for a review at all.
  const none = setup({ independence: "require" });
  const planC = none.add(planOf([task("db", ["src-db"])]));
  none.runner.approve(planC.id);
  assert.match((await none.runner.run(planC.id)).blockedBy.why, /no separate review/);
});

test("a blocker finding holds the plan; only a new, clean review lets it go on, and the task is not done again", async () => {
  const { runner, add, work, reviews } = setup(undefined, [blocker]);
  const plan = add(planOf([{ ...task("db", ["src-db"]), retries: 0 }, task("pricing", ["src-pricing"])], { verify: true, verifyModel: "opus" }));
  runner.approve(plan.id);
  const first = await runner.run(plan.id);
  assert.equal(first.status, "blocked");
  assert.equal(first.blockedBy.task, "db");
  assert.match(first.blockedBy.why, /1 blocker and 0 major/);
  assert.match(first.blockedBy.why, /candidate stays in its worktree/);
  assert.notEqual(first.tasks.db.status, "merged", "the candidate is held before merge");
  assert.equal(first.tasks.db.verification.blockers, 1);
  assert.equal(work.length, 1, "the next task did not start");
  // Running again: a NEW review (the report is now clean), not a new execution.
  const second = await runner.run(plan.id);
  assert.equal(second.status, "finished", JSON.stringify(second.blockedBy));
  assert.equal(reviews.length, 3, "one more review of db, then one of pricing");
  assert.equal(work.length, 2, "db was not done again");
  assert.notEqual(second.tasks.db.verification.task, first.tasks.db.verification.task);
  assert.equal(second.tasks.db.verification.blockers, 0);
});

test("a person can accept the findings; minor ones never hold the plan; an unfinished review blocks", async () => {
  const { runner, store, add, reviews } = setup(undefined, [blocker, minor]);
  const plan = add(planOf([{ ...task("db", ["src-db"]), retries: 0 }, task("pricing", ["src-pricing"])], { verify: true, verifyModel: "opus" }));
  runner.approve(plan.id);
  assert.equal((await runner.run(plan.id)).status, "blocked");
  assert.throws(() => store.accept(plan.id, "pricing"), /has no review to accept/);
  store.accept(plan.id, "db");
  const second = await runner.run(plan.id);
  assert.equal(second.status, "finished", JSON.stringify(second.blockedBy));
  assert.equal(reviews.length, 2, "db accepted: no new review of db; pricing's review had only a minor finding");
  assert.ok(second.tasks.db.verification.acceptedAt);
  assert.throws(() => store.accept(plan.id, "pricing"), /found nothing that holds the plan/);

  const crashed = setup(undefined, ["crash"]);
  const planB = crashed.add(planOf([{ ...task("db", ["src-db"]), retries: 0 }], { verify: true, verifyModel: "opus" }));
  crashed.runner.approve(planB.id);
  const stateB = await crashed.runner.run(planB.id);
  assert.equal(stateB.status, "blocked");
  assert.match(stateB.blockedBy.why, /did not finish/);
  assert.notEqual(stateB.tasks.db.status, "merged");
  assert.equal((await crashed.runner.run(planB.id)).status, "finished", "a new review, and the task is not redone");
  assert.equal(crashed.work.length, 1);
});

test("the CLI: plan accept needs a review that holds the plan", () => {
  const root = gitShop();
  const store = new PlanStore(root);
  const project = new ProjectState(root);
  const { analysis, model } = project.get();
  const { plan } = readPlan(planOf([{ ...task("db", ["src-db"]), retries: 0 }]), analysis, model);
  const stored = store.add(plan, { kind: "person" });
  const result = spawnSync(process.execPath, [cli, "plan", "accept", stored.id, "db", "-C", root], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has no review to accept/);
  const usage = spawnSync(process.execPath, [cli, "plan", "accept", stored.id, "-C", root], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});
