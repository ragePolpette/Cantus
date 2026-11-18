import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProjectState, TaskManager, startMapServer } from "../dist/index.js";
import { spawnSync } from "node:child_process";
import { finishWorktree, readReports } from "../dist/run/worktree-report.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function shop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

async function settled(task) {
  for (let i = 0; i < 1000; i++) {
    if (task.finishedAt) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`not settled: ${task.status} ${task.error ?? ""}`);
}

const refuse = () => { throw new Error("no agent runs in a prepared worktree"); };

async function prepared() {
  const root = shop();
  const tasks = new TaskManager(new ProjectState(root), refuse);
  const task = await settled(tasks.prepare({ block: "src-pricing", prompt: "Add VAT to prices" }));
  assert.equal(task.status, "prepared", task.error);
  return { root, tasks, task, folder: task.session.folder };
}

test("the file the session reads says where it is working and how to hand the work back", async () => {
  const { task, folder } = await prepared();
  const text = fs.readFileSync(path.join(folder, task.session.promptFile), "utf8");
  assert.match(text, /## Where you are working[^]*branch `cantus\/task-[^`]+`/);
  assert.match(text, /## Who you are[^]*lead of this worktree[^]*`block-<id>`/);
  assert.match(text, /## When you are done[^]*Commit your work[^]*`check`[^]*`worktree_done`/);
  assert.match(text, /Task: Add VAT to prices/, "the task itself is still there");
});

test("the session reports from its worktree: the main map sees it, and the state moves from prepared to review", async () => {
  const { root, tasks, task, folder } = await prepared();
  const listed = () => tasks.trackedWorktrees().worktrees.find((w) => w.task === task.id);
  assert.equal(listed().state, "prepared");
  assert.equal(listed().report, undefined);

  // Nothing committed yet: it is told, the report is still taken.
  const first = finishWorktree(folder, { summary: "Added VAT" });
  assert.equal(first.ok, true);
  assert.match(first.message, /Nothing is committed on this branch/);

  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  const loose = finishWorktree(folder, { summary: "Added VAT", tests: "npm test: 41 passed" });
  assert.match(loose.message, /1 file\(s\) are not committed \(src\/pricing\/index\.ts\)/);
  assert.equal(listed().state, "uncommitted", "work not committed is still first");
  assert.equal(listed().report.dirty, 1);

  git(folder, "commit", "-qam", "vat");
  const done = finishWorktree(folder, { summary: "Added VAT to the price quote.\nSecond line", tests: "npm test: 41 passed" });
  assert.equal(done.message, "Reported: the person sees it on the map of the main checkout, next to this worktree.");
  const row = listed();
  assert.equal(row.state, "review");
  assert.equal(row.report.summary, "Added VAT to the price quote.\nSecond line");
  assert.equal(row.report.tests, "npm test: 41 passed");
  assert.equal(row.report.dirty, 0);
  assert.equal(readReports(root).get(task.id).commit, git(folder, "rev-parse", "HEAD"));

  await tasks.discard(task.id).catch(() => {});
  assert.equal(readReports(root).size, 0, "the report goes with the worktree");
});

test("only a worktree Cantus made can report, and an empty summary is refused", async () => {
  const { root, folder } = await prepared();
  const main = finishWorktree(root, { summary: "x" });
  assert.equal(main.ok, false);
  assert.match(main.message, /not a worktree that Cantus made/);
  const hand = `${root}-hand`;
  git(root, "worktree", "add", "-q", "-b", "by-hand", hand);
  assert.equal(finishWorktree(hand, { summary: "x" }).ok, false, "made by hand: nobody to report to");
  assert.equal(finishWorktree(folder, { summary: "  " }).ok, false);
  assert.equal(finishWorktree(path.join(folder, "src"), { summary: "from a folder inside it" }).ok, true);
});

test("MCP: worktree_done reports from the worktree's session, worktrees lists them with what was reported", async (t) => {
  const { root, tasks, task, folder } = await prepared();
  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(folder, "commit", "-qam", "vat");
  const connect = async (cwd) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", cwd, "--no-ui"], stderr: "pipe" }));
    t.after(() => client.close());
    return async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
    };
  };
  const inWorktree = await connect(folder);
  const done = await inWorktree("worktree_done", { summary: "VAT added", tests: "all green" });
  assert.equal(done.isError, false, done.text);
  assert.match(done.text, /^Reported/);

  const fromMain = await connect(root);
  const list = await fromMain("worktrees");
  assert.match(list.text, /Worktrees of this repository/);
  assert.match(list.text, /Reported by the session of the worktree:\n\s+cantus\/task-[^:]+: VAT added \(tests: all green\)/);
  assert.equal((await fromMain("worktree_done", { summary: "x" })).isError, true, "the main checkout has nobody to report to");
  assert.equal(tasks.trackedWorktrees().worktrees.find((w) => w.task === task.id).state, "review");
});

test("a worktree prepared for your session keeps its task across a restart: merge and discard still work", async () => {
  const { root, task, folder } = await prepared();
  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(folder, "commit", "-qam", "vat");

  const again = new TaskManager(new ProjectState(root), refuse);
  const back = again.get(task.id);
  assert.equal(back.status, "prepared");
  assert.equal(back.session.folder, folder);
  assert.equal(back.worktree.branch, task.worktree.branch);

  // Another checkout's server (a worktree's map) does not take over this one's tasks: merging would go into the wrong branch.
  const elsewhere = new TaskManager(new ProjectState(folder), refuse);
  assert.deepEqual(elsewhere.list(), []);

  await again.merge(task.id);
  assert.equal(again.get(task.id).status, "merged");
  assert.match(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /vat = 0\.22/);
  assert.deepEqual(new TaskManager(new ProjectState(root), refuse).list().map((t) => t.status), [], "merged: it does not come back");
});

test("a prepared task whose worktree is gone does not come back", async () => {
  const { root, task, folder } = await prepared();
  git(root, "worktree", "remove", "--force", folder);
  assert.deepEqual(new TaskManager(new ProjectState(root), refuse).list(), []);
  assert.ok(task.id);
});

test("verify in a worktree Cantus made: the reviewer gets the task, the lead's report and the worktree's base; what the person says wins", async () => {
  const { root, task, folder } = await prepared();
  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(folder, "commit", "-qam", "vat");
  const dry = (...extra) => spawnSync(process.execPath, [cli, "verify", "--dry-run", "--no-tests", ...extra, "-C", folder], { encoding: "utf8" });

  // Before the lead reports: the task, compared with where the worktree started, and nothing claimed.
  const first = dry();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /## What the changes were meant to do\n\nTask: Add VAT to prices\n\nKeep changes inside the scope's paths/, "the task as the lead read it, without the briefing before it");
  assert.doesNotMatch(first.stdout, /Where you are working|Who you are|worktree_done/, "the rules the lead is given are not part of the request");
  assert.doesNotMatch(first.stdout, /What the author says it did/);
  assert.match(first.stdout, /Changed files \(compared with [^)]*\)/);
  assert.match(first.stdout, /`src\/pricing\/index\.ts`/);
  assert.match(first.stderr, /A worktree Cantus made/);

  // After worktree_done: its report is there, as a claim to check.
  finishWorktree(folder, { summary: "Added VAT to the price quote.", tests: "npm test: 41 passed" });
  const second = dry();
  assert.match(second.stdout, /## What the author says it did\n\nThese are claims to check, not facts:\n\nAdded VAT to the price quote\.\n\nTests it ran: npm test: 41 passed/);

  // What the person gives wins over the worktree's task; --base too.
  const about = dry("--about", "Just look at the rounding");
  assert.match(about.stdout, /## What the changes were meant to do\n\nJust look at the rounding/);
  assert.doesNotMatch(about.stdout, /Task: Add VAT to prices/);
  assert.doesNotMatch(about.stdout, /What the author says it did/, "a request given by the person: the worktree's report is not mixed in");
  const base = dry("--base", "HEAD");
  assert.match(base.stderr, /Nothing to verify/);
  assert.equal(base.status, 1);

  // Without the task file the first line of the task from the worktree list is what is left.
  fs.rmSync(path.join(folder, ".cantus/cache/session-task.md"));
  assert.match(dry().stdout, /## What the changes were meant to do\n\nAdd VAT to prices\n/);
  assert.equal(task.status, "prepared");
});

test("verify outside a worktree Cantus made: nothing is added", async () => {
  const { root } = await prepared();
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  const result = spawnSync(process.execPath, [cli, "verify", "--dry-run", "--no-tests", "-C", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No request was given/);
  assert.doesNotMatch(result.stderr, /A worktree Cantus made/);
});

test("verify through the map of a worktree's lead: the same task, report and base reach the reviewer; the person's words still win", async (t) => {
  const { folder } = await prepared();
  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(folder, "commit", "-qam", "vat");
  finishWorktree(folder, { summary: "Added VAT to the price quote." });
  const prompts = [];
  const runner = (request) => {
    prompts.push(request.prompt);
    return { [Symbol.asyncIterator]: () => (async function* () { yield { type: "result", ok: true, text: "```json\n" + JSON.stringify({ verdict: "ok", summary: "Fine.", checked: [], findings: [] }) + "\n```", costUsd: 0 }; })() };
  };
  const server = await startMapServer(new ProjectState(folder), { port: 0, pollInterval: 100, runner, session: true });
  t.after(() => server.close());
  let posted = 0;
  const post = async (body) => {
    const response = await fetch(new URL("api/verify", server.url), { method: "POST", headers: { "content-type": "application/json", "x-cantus-token": server.token }, body: JSON.stringify({ tests: false, deliver: false, ...body }) });
    assert.equal(response.status, 201);
    const task = await response.json();
    const wanted = ++posted;
    for (let i = 0; i < 500 && prompts.length < wanted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return task;
  };
  await post({});
  assert.match(prompts[0], /## What the changes were meant to do\n\nTask: Add VAT to prices/);
  assert.match(prompts[0], /## What the author says it did[^]*Added VAT to the price quote\./);
  await post({ about: "Look at the rounding only" });
  assert.match(prompts[1], /## What the changes were meant to do\n\nLook at the rounding only/);
  assert.doesNotMatch(prompts[1], /What the author says it did/);
});

test("the plan the lead wrote before it delegated reaches the reviewer as the lead's own criteria; without one nothing changes", async () => {
  const { folder } = await prepared();
  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(folder, "commit", "-qam", "vat");
  const dry = () => spawnSync(process.execPath, [cli, "verify", "--dry-run", "--no-tests", "-C", folder], { encoding: "utf8" });
  assert.doesNotMatch(dry().stdout, /Acceptance criteria the lead wrote/);
  fs.writeFileSync(path.join(folder, ".cantus/cache/session-plan.md"), "1. `npm test` passes.\n2. `quote()` in src/pricing/index.ts adds VAT.\n");
  const out = dry().stdout;
  assert.match(out, /Task: Add VAT to prices[^]*## Acceptance criteria the lead wrote before the work\n\n1\. `npm test` passes\.\n2\. `quote\(\)` in src\/pricing\/index\.ts adds VAT\./);
  assert.match(out, /they are the author's own: check them both ways/, "the reviewer is told what to do with them");
  // What the person gives wins: the plan is not added to a request they wrote.
  const given = spawnSync(process.execPath, [cli, "verify", "--dry-run", "--no-tests", "--about", "My words", "-C", folder], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(given, /Acceptance criteria the lead wrote/);
});

const usageLine = (extra) => JSON.stringify({ t: new Date().toISOString(), kind: "edit", phase: "after", broken: 0, ...extra });

test("the report says who wrote the files: from the hooks' record, the lead's and each specialist's, distinct files", async () => {
  const { folder } = await prepared();
  fs.mkdirSync(path.join(folder, ".cantus/cache"), { recursive: true });
  const edits = [
    // The lead: three edits on two files.
    { file: "src/pricing/index.ts" }, { file: "src/pricing/index.ts" }, { file: "src/orders/index.ts" },
    // A specialist: four edits on three files.
    { file: "src/pricing/a.ts", agent: "block-a" }, { file: "src/pricing/b.ts", agent: "block-a" }, { file: "src/pricing/c.ts", agent: "block-a" }, { file: "src/pricing/a.ts", agent: "block-a" },
  ];
  fs.writeFileSync(path.join(folder, ".cantus/cache/usage.jsonl"), [...edits.map((edit) => usageLine(edit)), JSON.stringify({ t: new Date().toISOString(), kind: "tool", tool: "map", ok: true, tokens: 10 }), "a half-written li"].join("\n"));
  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(folder, "commit", "-qam", "work");
  assert.equal(finishWorktree(folder, { summary: "Done" }).ok, true);
  const report = [...readReports(folder).values()][0];
  assert.deepEqual(report.writers, { lead: 2, specialists: { "block-a": 3 } });

  // The same line goes to the reviewer, with what it does not count.
  const out = spawnSync(process.execPath, [cli, "verify", "--dry-run", "--no-tests", "-C", folder], { encoding: "utf8" });
  assert.match(out.stdout, /## What the author says it did[^]*Written by \(files edited, from the hooks' record; edits made with the shell are not counted\): lead 2 files · block-a 3 files/);
});

test("without a record of the hooks the report is as before and says nothing about who wrote", async () => {
  const { folder } = await prepared();
  fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(folder, "commit", "-qam", "work");
  fs.writeFileSync(path.join(folder, ".cantus/cache/usage.jsonl"), usageLine({ file: "x.ts", agent: "block-a" }).replace('"kind":"edit"', '"kind":"read"') + "\n");
  assert.equal(finishWorktree(folder, { summary: "Done" }).ok, true, "a record with no edit in it");
  assert.equal([...readReports(folder).values()][0].writers, undefined);
  fs.rmSync(path.join(folder, ".cantus/cache/usage.jsonl"));
  assert.equal(finishWorktree(folder, { summary: "Done again" }).ok, true);
  const report = [...readReports(folder).values()][0];
  assert.equal(report.writers, undefined);
  assert.equal("writers" in report, false);
  const out = spawnSync(process.execPath, [cli, "verify", "--dry-run", "--no-tests", "-C", folder], { encoding: "utf8" });
  assert.match(out.stdout, /What the author says it did/, "the report itself is there");
  assert.doesNotMatch(out.stdout, /Written by/);
});
