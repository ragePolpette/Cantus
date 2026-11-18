import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

function mappedShop({ git = false } = {}) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  if (git) {
    fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n");
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

/**
 * A scripted stand-in for Claude Code: `script(request, session)` is an async generator that
 * yields runner messages and calls `request.canUseTool` where the real agent would ask.
 */
function fakeRunner(script) {
  const runs = [];
  const runner = (request) => {
    const session = {
      request,
      modes: [],
      async setPermissionMode(mode) {
        session.modes.push(mode);
      },
      [Symbol.asyncIterator]: () => script(request, session),
    };
    runs.push(session);
    return session;
  };
  return { runner, runs };
}

async function waitFor(check, what = "condition") {
  for (let i = 0; i < 500; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Asks like the agent would, then writes the file if allowed. */
async function* edit(request, file, content) {
  const decision = await request.canUseTool("Edit", { file_path: path.join(request.cwd, file), old_string: "x", new_string: "y" }, request.abort.signal);
  if (!decision.allow) {
    yield { type: "text", text: `Skipped ${file}: ${decision.message}` };
    return false;
  }
  fs.mkdirSync(path.dirname(path.join(request.cwd, file)), { recursive: true });
  fs.appendFileSync(path.join(request.cwd, file), content);
  yield { type: "tool", tool: "Edit", input: { file_path: path.join(request.cwd, file) } };
  return true;
}

test("an edit task asks before each change, flags files outside its scope, and briefs the agent", async () => {
  const root = mappedShop();
  const { runner, runs } = fakeRunner(async function* (request) {
    yield { type: "tool", tool: "Read", input: { file_path: path.join(request.cwd, "src/checkout/index.ts") } };
    const question = await request.canUseTool("AskUserQuestion", { questions: [] }, request.abort.signal);
    yield { type: "text", text: question.allow ? "asked" : `no questions: ${question.message}` };
    yield* edit(request, "src/checkout/cart.ts", "\nexport const discount = 0.1;\n");
    yield* edit(request, "src/db/client.ts", "\n// touched\n");
    yield { type: "result", ok: true, text: "Added the discount.", costUsd: 0.01 };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-checkout", prompt: "Add a discount", mode: "edit" });

  assert.equal(runs[0].request.permissionMode, "default");
  assert.equal(runs[0].request.cwd, root);
  assert.match(runs[0].request.prompt, /Your scope for this task is the block `src-checkout`/);
  assert.match(runs[0].request.prompt, /`src\/web\/checkout-page\.ts:5` \(src-web\)/, "the briefing lists the scope's callers");
  assert.match(runs[0].request.prompt, /Task: Add a discount/);

  const inside = await waitFor(() => task.approvals[0], "the first approval");
  assert.equal(task.status, "waiting");
  assert.deepEqual([inside.kind, inside.tool, inside.file, inside.outsideScope], ["tool", "Edit", "src/checkout/cart.ts", undefined]);
  assert.match(task.events.find((event) => event.kind === "text").text, /no questions: Questions go to the user through the Cantus map/);
  tasks.decide(task.id, inside.id, { allow: true });

  const outside = await waitFor(() => task.approvals.find((approval) => approval.file === "src/db/client.ts"), "the outside approval");
  assert.equal(outside.outsideScope, true);
  tasks.decide(task.id, outside.id, { allow: false, message: "Not in this task." });

  await waitFor(() => task.status === "done", "the task to finish");
  assert.equal(task.result, "Added the discount.");
  assert.equal(inside.summary, "Edit src/checkout/cart.ts", "summaries show repo-relative paths");
  assert.equal(task.costUsd, 0.01);
  assert.deepEqual(task.touchedFiles, ["src/checkout/index.ts", "src/checkout/cart.ts"]);
  assert.deepEqual(task.changedFiles, ["src/checkout/cart.ts"]);
  assert.deepEqual(task.touchedBlocks, ["src-checkout"]);
  assert.match(task.events.map((event) => event.text).join("\n"), /Skipped src\/db\/client\.ts: Not in this task\./);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "src/db/client.ts"), "utf8"), /touched/);
  assert.match(tasks.diff(task.id), /changed: src\/checkout\/cart\.ts/);
  assert.throws(() => tasks.decide(task.id, "nope", { allow: true }), /No pending approval/);
  await assert.rejects(tasks.merge(task.id), /Only worktree tasks are merged/);
});

test("a plan task waits for the plan, then edits; 'always' and 'accept edits' stop the questions", async () => {
  const root = mappedShop();
  const { runner, runs } = fakeRunner(async function* (request) {
    yield { type: "text", text: "Plan: 1. add discount 2. use it in placeOrder" };
    const plan = await request.canUseTool("ExitPlanMode", {}, request.abort.signal);
    if (!plan.allow) return yield { type: "result", ok: false, text: "plan rejected" };
    yield* edit(request, "src/checkout/cart.ts", "\n// one\n");
    yield* edit(request, "src/checkout/cart.ts", "\n// two\n");
    const bash = await request.canUseTool("Bash", { command: "npm test" }, request.abort.signal);
    yield { type: "text", text: `bash ${bash.allow}` };
    yield* edit(request, "src/checkout/index.ts", "\n// three\n");
    yield { type: "result", ok: true, text: "done" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ group: undefined, blocks: ["src-checkout", "src-pricing"], prompt: "Discounts" });
  assert.equal(task.mode, "plan");
  assert.equal(runs[0].request.permissionMode, "plan");
  assert.match(runs[0].request.prompt, /the group Scope: src-checkout, src-pricing \(src-checkout, src-pricing\)/);

  const plan = await waitFor(() => task.approvals[0]);
  assert.deepEqual([plan.kind, plan.summary], ["plan", "Plan: 1. add discount 2. use it in placeOrder"]);
  tasks.decide(task.id, plan.id, { allow: true });
  await waitFor(() => runs[0].modes.includes("default"), "the switch out of plan mode");

  const first = await waitFor(() => task.approvals.find((approval) => approval.tool === "Edit"));
  tasks.decide(task.id, first.id, { allow: true, alwaysForTool: true });
  const bash = await waitFor(() => task.approvals.find((approval) => approval.tool === "Bash"), "the Bash approval (the second Edit did not ask)");
  assert.equal(bash.summary, "Bash: npm test");
  tasks.decide(task.id, bash.id, { allow: true });
  await waitFor(() => task.status === "done");
  assert.equal(task.events.filter((event) => event.kind === "approval").length, 3);
  assert.match(fs.readFileSync(path.join(root, "src/checkout/index.ts"), "utf8"), /three/);

  const { runner: second, runs: secondRuns } = fakeRunner(async function* (request) {
    yield* edit(request, "src/pricing/index.ts", "\n// accepted\n");
    yield* edit(request, "src/pricing/index.ts", "\n// accepted again\n");
    yield* edit(request, "src/web/checkout-page.ts", "\n// outside\n");
    yield { type: "result", ok: true, text: "done" };
  });
  const more = new TaskManager(new ProjectState(root), second);
  const run = more.start({ block: "src-pricing", prompt: "Tweak", mode: "edit" });
  await waitFor(() => run.approvals.length === 1);
  await more.acceptEdits(run.id);
  const outside = await waitFor(() => run.approvals[0]?.outsideScope && run.approvals[0]);
  assert.equal(outside.file, "src/web/checkout-page.ts", "an edit outside the scope still asks after accepting edits");
  assert.deepEqual(secondRuns[0].modes, [], "Claude Code stays in a mode that asks Cantus");
  more.decide(run.id, outside.id, { allow: false });
  await waitFor(() => run.status === "done");
  assert.match(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /accepted again/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "src/web/checkout-page.ts"), "utf8"), /outside/);
  assert.match(run.events.map((event) => event.text).join("\n"), /Edits inside the scope are accepted without asking/);
});

test("the plan to review is the one Claude Code passes to ExitPlanMode, even with nothing said before it", async () => {
  const root = mappedShop();
  const { runner } = fakeRunner(async function* (request) {
    const plan = await request.canUseTool("ExitPlanMode", { plan: "  1. add discount\n2. use it in placeOrder\n" }, request.abort.signal);
    yield { type: "result", ok: plan.allow, text: "done" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ group: undefined, blocks: ["src-checkout"], prompt: "Discounts" });
  const plan = await waitFor(() => task.approvals[0], "the plan approval");
  assert.deepEqual([plan.kind, plan.summary], ["plan", "1. add discount\n2. use it in placeOrder"]);
  tasks.decide(task.id, plan.id, { allow: true });
  await waitFor(() => task.status === "done", "the task to finish");
  assert.ok(task.events.some((event) => event.kind === "decision" && event.text === "Allowed: the plan"), "the log names the plan, not its whole text");
});

test("stopping a task denies what it waits for and ends it", async () => {
  const root = mappedShop();
  let denial;
  const { runner } = fakeRunner(async function* (request) {
    const decision = await request.canUseTool("Write", { file_path: path.join(request.cwd, "src/web/new.ts") }, request.abort.signal);
    denial = decision;
    if (request.abort.signal.aborted) throw new Error("aborted");
    yield { type: "result", ok: true, text: "should not finish" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-web", prompt: "New page", mode: "edit" });
  await waitFor(() => task.approvals.length === 1);
  tasks.stop(task.id);
  assert.equal(task.status, "stopped");
  await waitFor(() => denial);
  assert.deepEqual(denial, { allow: false, message: "The user stopped the task." });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(task.status, "stopped");
  assert.throws(() => tasks.stop(task.id), /not running/);
  assert.throws(() => tasks.get("nope"), /No task "nope"/);
  assert.throws(() => tasks.start({ block: "src-web", prompt: " " }), /needs a prompt/);
});

test("a worktree task works on its own branch, then is merged or discarded", async () => {
  const root = mappedShop({ git: true });
  const { runner, runs } = fakeRunner(async function* (request) {
    yield* edit(request, "src/pricing/index.ts", "\nexport const vat = 0.22;\n");
    yield { type: "result", ok: true, text: "VAT added" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree" });
  await waitFor(() => runs[0]);
  assert.notEqual(runs[0].request.cwd, root);
  assert.equal(task.worktree.branch, `cantus/task-${task.id}`);
  const approval = await waitFor(() => task.approvals[0]);
  assert.equal(approval.file, "src/pricing/index.ts", "paths are relative to the worktree");
  assert.equal(approval.outsideScope, undefined);
  tasks.decide(task.id, approval.id, { allow: true });
  await waitFor(() => task.status === "done" && task.finishedAt);

  assert.doesNotMatch(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /vat/, "the main checkout is untouched");
  assert.deepEqual(task.changedFiles, ["src/pricing/index.ts"]);
  assert.match(tasks.diff(task.id), /\+export const vat = 0\.22;/);
  await assert.rejects(tasks.discard("nope"), /No task/);
  await tasks.merge(task.id);
  assert.equal(task.status, "merged");
  assert.match(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /vat = 0\.22/);
  assert.equal(fs.existsSync(task.worktree.path), false);
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" }), /cantus\/task-/);

  const other = tasks.start({ block: "src-pricing", prompt: "Something else", mode: "edit", isolation: "worktree" });
  tasks.decide(other.id, (await waitFor(() => other.approvals[0])).id, { allow: true });
  await waitFor(() => other.status === "done" && other.finishedAt);
  await tasks.discard(other.id);
  assert.equal(other.status, "discarded");
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" }), /cantus\/task-/);
  assert.throws(() => new TaskManager(new ProjectState(mappedShop()), runner).start({ block: "src-web", prompt: "x", isolation: "worktree" }), /needs a git repository/);
});

test("a worktree task is done only once its work is committed, so it can't be merged empty", async () => {
  const root = mappedShop({ git: true });
  let release;
  const { runner } = fakeRunner(async function* (request) {
    yield* edit(request, "src/pricing/index.ts", "\nexport const vat = 0.22;\n");
    yield { type: "result", ok: true, text: "VAT added" };
    // Claude Code's stream stays open a moment after its result.
    await new Promise((resolve) => (release = resolve));
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree" });
  tasks.decide(task.id, (await waitFor(() => task.approvals[0])).id, { allow: true });
  await waitFor(() => task.result);
  assert.equal(task.status, "running");
  await assert.rejects(tasks.merge(task.id));
  release();
  await waitFor(() => task.status === "done");
  assert.match(tasks.diff(task.id), /\+export const vat = 0\.22;/);
});

test("a worktree is made in the background, and a task stopped before its agent starts leaves nothing behind", async () => {
  const root = mappedShop({ git: true });
  const { runner, runs } = fakeRunner(async function* () {
    yield { type: "result", ok: true, text: "should not run" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree" });
  assert.equal(fs.existsSync(task.worktree.path), false, "start answers before git has made the worktree");
  tasks.stop(task.id);
  assert.equal(task.status, "stopped");
  await assert.rejects(tasks.discard(task.id), /still being created/);
  for (let tries = 0; ; tries++) {
    const outcome = await tasks.discard(task.id).then(() => "discarded", (error) => String(error));
    if (outcome === "discarded") break;
    assert.match(outcome, /still being created/);
    assert.ok(tries < 200, "the worktree is made within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(runs.length, 0, "the agent never started");
  assert.equal(task.status, "discarded");
  assert.equal(fs.existsSync(task.worktree.path), false);
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" }), /cantus\/task-/);
});

function request(server, { method = "GET", pathname, token, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: pathname, headers: { ...(token ? { "x-cantus-token": token } : {}), "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: () => JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("a worktree task on a project in a folder of a bigger repository works in that folder", async () => {
  const project = mappedShop();
  const repo = fs.mkdtempSync(path.join(path.dirname(project), "monorepo-"));
  fs.renameSync(project, path.join(repo, "app"));
  const root = path.join(repo, "app");
  fs.writeFileSync(path.join(repo, "README.md"), "other things\n");
  // A repository that tracks Cantus's cache, with no .gitignore for it.
  fs.mkdirSync(path.join(root, ".cantus/cache"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/cache/index.json"), "{}\n");
  const run = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  const { runner, runs } = fakeRunner(async function* (request) {
    yield* edit(request, "src/pricing/index.ts", "\nexport const vat = 0.22;\n");
    fs.writeFileSync(path.join(request.cwd, ".cantus/cache/index.json"), '{"worktree":true}\n');
    yield { type: "result", ok: true, text: "VAT added" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree" });
  await waitFor(() => runs[0]);
  assert.equal(runs[0].request.cwd, path.join(task.worktree.path, "app"), "the agent starts in the project's folder of the worktree");
  const approval = await waitFor(() => task.approvals[0]);
  assert.deepEqual([approval.file, approval.outsideScope], ["src/pricing/index.ts", undefined], "paths are relative to the project, so the scope holds");
  tasks.decide(task.id, approval.id, { allow: true });
  await waitFor(() => task.status === "done" && task.finishedAt);
  assert.deepEqual(task.changedFiles, ["src/pricing/index.ts"], "Cantus's cache stays out of the task's commit");
  assert.deepEqual(task.touchedBlocks, ["src-pricing"]);
  fs.writeFileSync(path.join(root, ".cantus/cache/index.json"), '{"main":true}\n');
  await tasks.merge(task.id);
  assert.match(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /vat = 0\.22/);
  assert.equal(fs.existsSync(path.join(repo, "src")), false, "nothing lands at the repository's top level");
});

test("a worktree task gets the specialists and notes that the project keeps out of git", async () => {
  const root = mappedShop({ git: true });
  // Kept out of git by the user, as in a repository with .claude/ and AGENTS.md in .git/info/exclude.
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".claude/\nAGENTS.md\n");
  fs.mkdirSync(path.join(root, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/agents/block-src-pricing.md"), "---\nname: block-src-pricing\n---\n");
  fs.writeFileSync(path.join(root, "src/pricing/AGENTS.md"), "# Notes: Pricing\n");
  const seen = {};
  const { runner } = fakeRunner(async function* (request) {
    for (const file of [".claude/agents/block-src-pricing.md", "src/pricing/AGENTS.md"]) seen[file] = fs.existsSync(path.join(request.cwd, file));
    yield* edit(request, "src/pricing/index.ts", "\nexport const vat = 0.22;\n");
    yield { type: "result", ok: true, text: "VAT added" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree" });
  tasks.decide(task.id, (await waitFor(() => task.approvals[0])).id, { allow: true });
  await waitFor(() => task.status === "done" && task.finishedAt);
  assert.deepEqual(seen, { ".claude/agents/block-src-pricing.md": true, "src/pricing/AGENTS.md": true }, "the agent finds the specialist and the notes");
  assert.deepEqual(task.changedFiles, ["src/pricing/index.ts"], "the copies stay ignored, out of the task's commit");
  await tasks.merge(task.id);
  assert.match(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /vat = 0\.22/);
});

test("a worktree task gets the map and the specialists not committed yet, and keeps them out of its commit", async () => {
  const root = mappedShop({ git: true });
  // A sketch just kept on the map and specialists just generated: neither is committed.
  const model = shopModel();
  model.blocks.push({ id: "src-wishlist", name: "Wishlist", layer: "domain", include: ["src/wishlist"] });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  fs.mkdirSync(path.join(root, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/agents/block-src-wishlist.md"), "---\nname: block-src-wishlist\n---\n");
  const seen = {};
  const { runner } = fakeRunner(async function* (request) {
    seen.specialist = fs.existsSync(path.join(request.cwd, ".claude/agents/block-src-wishlist.md"));
    seen.map = /src-wishlist/.test(fs.readFileSync(path.join(request.cwd, ".cantus/model.json"), "utf8"));
    yield* edit(request, "src/pricing/index.ts", "\nexport const vat = 0.22;\n");
    yield { type: "result", ok: true, text: "VAT added" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree" });
  tasks.decide(task.id, (await waitFor(() => task.approvals[0])).id, { allow: true });
  await waitFor(() => task.status === "done" && task.finishedAt);
  assert.deepEqual(seen, { specialist: true, map: true }, "the agent finds the sketched map and the new specialist");
  assert.deepEqual(task.changedFiles, ["src/pricing/index.ts"], "the copies stay out of the task's commit");
  assert.ok(task.events.some((event) => /Not committed yet, copied into the worktree.*\.cantus\/model\.json/.test(event.text)));
  await tasks.merge(task.id);
  assert.equal(task.status, "merged", "the merge does not trip over the uncommitted files in the checkout");
  assert.match(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"), /src-wishlist/, "the checkout keeps its own map");
});

test("a worktree task commits but preserves a carried file with no baseline before merge", async () => {
  const root = mappedShop({ git: true });
  // A committed note that the checkout has since changed: carried in, but its change is not the task's.
  fs.writeFileSync(path.join(root, "src/pricing/AGENTS.md"), "# Notes: Pricing (old)\n");
  for (const args of [["add", "-A"], ["commit", "-qm", "notes"]]) execFileSync("git", args, { cwd: root, stdio: "ignore" });
  fs.appendFileSync(path.join(root, ".git/info/exclude"), ".claude/\n");
  fs.mkdirSync(path.join(root, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/agents/block-src-pricing.md"), "---\nname: block-src-pricing\n---\n");
  fs.writeFileSync(path.join(root, "src/pricing/AGENTS.md"), "# Notes: Pricing (new)\n");
  let task;
  const { runner } = fakeRunner(async function* (request) {
    // Simulate a legacy record that lists the ignored copy but has no fingerprint for it.
    const copy = ".claude/agents/block-src-pricing.md";
    task.worktree.carried = [...task.worktree.carried, copy];
    delete task.carriedHashes[copy];
    yield* edit(request, "src/pricing/index.ts", "\nexport const vat = 0.22;\n");
    yield { type: "result", ok: true, text: "VAT added" };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree" });
  tasks.decide(task.id, (await waitFor(() => task.approvals[0])).id, { allow: true });
  await waitFor(() => task.finishedAt);
  assert.equal(task.status, "done", task.error);
  assert.deepEqual(task.changedFiles, ["src/pricing/index.ts"], "neither the ignored copy nor the changed note is in the commit");
  await assert.rejects(tasks.merge(task.id), /changes that are not committed/);
  assert.ok(fs.existsSync(path.join(task.worktree.path, ".claude/agents/block-src-pricing.md")));
  assert.match(fs.readFileSync(path.join(root, "src/pricing/AGENTS.md"), "utf8"), /\(new\)/, "the checkout keeps its own note");
});

test("a worktree task in a repository without commits says to commit first", () => {
  const root = mappedShop();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const { runner } = fakeRunner(async function* () {});
  assert.throws(() => new TaskManager(new ProjectState(root), runner).start({ block: "src-web", prompt: "x", isolation: "worktree" }), /needs a first commit/);
});

test("the map server starts tasks, streams their updates and takes decisions", async (t) => {
  const root = mappedShop();
  const { runner } = fakeRunner(async function* (request) {
    yield* edit(request, "src/orders/index.ts", "\n// api\n");
    yield { type: "result", ok: true, text: "ok" };
  });
  const server = await startMapServer(new ProjectState(root), { port: 0, runner });
  t.after(() => server.close());
  const { token } = server;

  const updates = [];
  const events = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      for (const match of chunk.matchAll(/event: task\ndata: (.*)\n\n/g)) updates.push(JSON.parse(match[1]));
    });
  });
  t.after(() => events.destroy());
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal((await request(server, { method: "POST", pathname: "/api/tasks", body: { block: "src-orders", prompt: "x" } })).status, 403, "the token is required");
  assert.equal((await request(server, { method: "POST", pathname: "/api/tasks", token, body: { block: "src-nope", prompt: "x" } })).status, 400);
  const created = await request(server, { method: "POST", pathname: "/api/tasks", token, body: { block: "src-orders", prompt: "Expose the API", mode: "edit" } });
  assert.equal(created.status, 201);
  const { id } = created.json();

  const waiting = await waitFor(() => updates.find((update) => update.id === id && update.approvals.length === 1), "a task event with the approval");
  const decided = await request(server, { method: "POST", pathname: `/api/tasks/${id}/approvals/${waiting.approvals[0].id}`, token, body: { allow: true } });
  assert.equal(decided.status, 200);
  await waitFor(() => updates.some((update) => update.id === id && update.status === "done"), "the done event");

  assert.equal((await request(server, { pathname: "/api/tasks", token })).json()[0].id, id);
  assert.deepEqual((await request(server, { pathname: `/api/tasks/${id}`, token })).json().changedFiles, ["src/orders/index.ts"]);
  assert.equal((await request(server, { pathname: `/api/tasks/${id}/diff`, token })).status, 200);
  assert.equal((await request(server, { method: "POST", pathname: `/api/tasks/${id}/merge`, token })).status, 400);
  assert.equal((await request(server, { pathname: "/api/tasks/nope", token })).status, 404);
  const revisions = updates.filter((update) => update.id === id).map((update) => update.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), "every update carries a growing revision");
  assert.ok(new Set(revisions).size === revisions.length);
});

test("the live page carries the task controls; the static view does not", async (t) => {
  const { runner } = fakeRunner(async function* () {});
  const server = await startMapServer(new ProjectState(mappedShop()), { port: 0, runner });
  t.after(() => server.close());
  const page = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: server.port, path: "/" }, (res) => { let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => resolve(raw)); }));
  for (const piece of ["Start a task on", "Merge into your branch", 'addEventListener("task"', "code changed · reload"]) assert.ok(page.includes(piece), piece);
  assert.match(page, new RegExp(`"token":"${server.token}"`));
});

test("a task on the whole project: Claude Code gets the map and delegates; each delegation is followed", async () => {
  const root = mappedShop();
  fs.mkdirSync(path.join(root, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/agents/block-src-pricing.md"), "---\nname: block-src-pricing\n---\n");
  const { runner, runs } = fakeRunner(async function* (request) {
    yield { type: "text", text: "Pricing first, then checkout." };
    yield { type: "tool", tool: "Agent", id: "call-1", input: { subagent_type: "block-src-pricing", description: "Add VAT to quote()", prompt: "…" } };
    yield* edit(request, "src/pricing/index.ts", "\n// vat\n");
    yield { type: "tool", tool: "Edit", id: "call-2", parent: "call-1", input: { file_path: path.join(request.cwd, "src/pricing/index.ts") } };
    yield { type: "tool-done", id: "call-1" };
    yield { type: "tool", tool: "Agent", id: "call-3", input: { subagent_type: "general-purpose", description: "Update checkout" } };
    yield { type: "result", ok: true, text: "Done." };
  });
  const tasks = new TaskManager(new ProjectState(root), runner, { policy: () => ({ allow: true }) });
  const task = tasks.start({ orchestrate: true, block: "ignored", prompt: "Add VAT everywhere", mode: "edit" });
  const prompt = runs[0].request.prompt;
  assert.match(prompt, /^You coordinate work on a project mapped by Cantus/);
  assert.match(prompt, /# Project: shop \(6 blocks\)[\s\S]*- `src-pricing` Pricing \(domain\), `src\/pricing`\. Uses: —\. Used by: src-checkout\./);
  assert.match(prompt, /Subagents you can delegate to: `block-src-pricing`\./);
  assert.match(prompt, /Task: Add VAT everywhere/);
  assert.match(prompt, /Don't edit code yourself when the plan touches more than one block: each block's piece goes to its specialist, however small/);
  assert.doesNotMatch(prompt, /Small changes that touch one file you may do yourself/);

  const done = await tasks.wait(task.id);
  assert.equal(done.orchestrated, true);
  assert.equal(done.scope.blocks.length, 6);
  assert.deepEqual(done.delegations.map((delegation) => `${delegation.agent} ${delegation.status} [${delegation.blocks}] ${delegation.files} ${delegation.description}`), [
    "block-src-pricing done [src-pricing] src/pricing/index.ts Add VAT to quote()",
    "general-purpose done []  Update checkout",
  ]);
  assert.match(done.events.map((event) => event.text).join("\n"), /Delegated to block-src-pricing \(src-pricing\): Add VAT to quote\(\)[\s\S]*\[block-src-pricing\] Edit src\/pricing\/index\.ts[\s\S]*block-src-pricing finished: Add VAT to quote\(\)/);
});

test("a task on a block planned on the map works inside its folder before any code is there", async () => {
  const root = mappedShop();
  const model = shopModel();
  model.blocks.push({ id: "src-wishlist", name: "Wishlist", layer: "domain", include: ["src/wishlist"], description: "Saved items" });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  const { runner, runs } = fakeRunner(async function* (request) {
    yield* edit(request, "src/wishlist/index.ts", "export const wishlist: string[] = [];\n");
    yield* edit(request, "src/db/client.ts", "\n// touched\n");
    yield { type: "result", ok: true, text: "Built the wishlist.", costUsd: 0 };
  });
  const tasks = new TaskManager(new ProjectState(root), runner, { policy: (approval) => (approval.outsideScope ? { allow: false, message: "outside" } : { allow: true }) });
  const task = tasks.start({ block: "src-wishlist", prompt: "Build the wishlist", mode: "edit" });
  assert.match(runs[0].request.prompt, /Your scope for this task is the block `src-wishlist`/);
  await waitFor(() => task.status === "done", "the task to finish");
  assert.equal(fs.readFileSync(path.join(root, "src/wishlist/index.ts"), "utf8"), "export const wishlist: string[] = [];\n");
  assert.deepEqual(task.changedFiles, ["src/wishlist/index.ts"]);
  assert.ok(task.events.some((event) => event.kind === "decision" && /Allowed by policy: Edit src\/wishlist\/index\.ts/.test(event.text)), "its own folder is inside the scope");
  assert.ok(task.events.some((event) => event.kind === "decision" && /Denied by policy: Edit src\/db\/client\.ts/.test(event.text)), "other blocks are outside it");
});

test("tests and documents no block owns are part of a task; manifests, source files no block owns and dot-files are not", async () => {
  const root = mappedShop();
  const files = ["test/checkout.test.mjs", "CHANGELOG.md", "docs/guide.md", "package.json", "src/newthing/extra.ts", ".env", "src/db/client.ts"];
  const { runner } = fakeRunner(async function* (request) {
    for (const file of files) yield* edit(request, file, "\n// x\n");
    yield { type: "result", ok: true, text: "done", costUsd: 0 };
  });
  const tasks = new TaskManager(new ProjectState(root), runner, { policy: (approval) => (approval.outsideScope ? { allow: false, message: "outside" } : { allow: true }) });
  const task = tasks.start({ block: "src-checkout", prompt: "Add a discount", mode: "edit" });
  await waitFor(() => task.status === "done", "the task to finish");
  assert.deepEqual(task.changedFiles, ["test/checkout.test.mjs", "CHANGELOG.md", "docs/guide.md"]);
  const denied = task.events.filter((event) => event.kind === "decision" && /^Denied/.test(event.text)).map((event) => event.file);
  assert.deepEqual(denied, ["package.json", "src/newthing/extra.ts", ".env", "src/db/client.ts"]);
});

test("the prompt stream hands the session the task's prompt, then waits until it ends", async () => {
  const { promptStream } = await import("../dist/run/sdk-runner.js");
  const { stream, end } = promptStream("Do the task");
  const seen = [];
  const reader = (async () => {
    for await (const message of stream) seen.push(message.message.content);
  })();
  await waitFor(() => seen.length === 1, "the prompt to be read");
  assert.deepEqual(seen, ["Do the task"]);
  end();
  await reader;
  assert.deepEqual(seen, ["Do the task"], "nothing more once it ends");
});

test("a task takes the model chosen for it, else the map's, and refuses a name that is not one", async () => {
  const root = mappedShop();
  const { runner, runs } = fakeRunner(async function* () {
    yield { type: "result", ok: true, text: "Done." };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  assert.throws(() => tasks.start({ block: "src-checkout", prompt: "x", model: "opus; rm -rf" }), /not a model name/);
  assert.throws(() => tasks.start({ block: "src-checkout", prompt: "x", model: " " }), /not a model name/);
  assert.equal(runs.length, 0, "nothing started");

  const cheap = tasks.start({ block: "src-checkout", prompt: "Rename a variable", model: "haiku" });
  assert.equal(runs[0].request.model, "haiku");
  assert.equal(cheap.model, "haiku");
  await waitFor(() => cheap.status === "done", "the task to finish");

  const plain = tasks.start({ block: "src-checkout", prompt: "Another" });
  assert.equal(runs[1].request.model, undefined, "no choice and nothing in the map: Claude Code's own default");
  assert.equal(plain.model, undefined);

  const model = shopModel();
  model.agent = { model: "sonnet" };
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  const mapped = new TaskManager(new ProjectState(root), runner);
  const inherited = mapped.start({ block: "src-checkout", prompt: "From the map's setting" });
  assert.equal(runs[2].request.model, "sonnet");
  assert.equal(inherited.model, "sonnet");
  assert.equal(mapped.start({ block: "src-checkout", prompt: "Overridden", model: "claude-opus-5-5" }).model, "claude-opus-5-5");
  assert.equal(runs[3].request.model, "claude-opus-5-5");
});

test("a task started from the map gets a briefing within the budget, the neighbor's unused exports counted and not listed", async () => {
  const root = mappedShop();
  fs.writeFileSync(path.join(root, "src/pricing/big.ts"), Array.from({ length: 3000 }, (_, i) => `/** Rate number ${i}, documented at length so the briefing grows. */\nexport function rate${i}(amount: number): number { return amount * ${i}; }`).join("\n") + "\n");
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), 'export * from "./big.js";\n');
  const state = new ProjectState(root);
  const { runner, runs } = fakeRunner(async function* () {
    yield { type: "result", costUsd: 0 };
  });
  const tasks = new TaskManager(state, runner);
  const task = tasks.start({ prompt: "Add a discount", block: "src-checkout", mode: "edit" });
  await tasks.wait(task.id);
  const prompt = runs[0].request.prompt;
  assert.ok(prompt.length / 4 < 14_500, `~${Math.round(prompt.length / 4)} tokens`);
  assert.doesNotMatch(prompt, /rate2999/);
});

test("a task knows the Claude Code session that runs it and says how to open it in a terminal", async () => {
  const root = mappedShop();
  const { runner } = fakeRunner(async function* () {
    yield { type: "session", id: "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab" };
    yield { type: "result", ok: true, text: "Done." };
  });
  const tasks = new TaskManager(new ProjectState(root), runner, { policy: () => ({ allow: true }) });
  const done = await tasks.wait(tasks.start({ block: "src-pricing", prompt: "Look", mode: "edit" }).id);
  assert.equal(done.claude.sessionId, "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab");
  assert.equal(done.claude.folder, root);
  assert.equal(done.claude.resume, `cd "${root}"\nclaude --resume 0b1c2d3e-aaaa-bbbb-cccc-1234567890ab`);
  assert.ok(done.events.some((event) => /claude --resume 0b1c2d3e/.test(event.text)));
});

test("an id a shell could read as more than an id is not offered as a command", async () => {
  const { runner } = fakeRunner(async function* () {
    yield { type: "session", id: "x; rm -rf /" };
    yield { type: "result", ok: true, text: "Done." };
  });
  const tasks = new TaskManager(new ProjectState(mappedShop()), runner, { policy: () => ({ allow: true }) });
  const done = await tasks.wait(tasks.start({ block: "src-pricing", prompt: "Look", mode: "edit" }).id);
  assert.equal(done.claude, undefined);
});
