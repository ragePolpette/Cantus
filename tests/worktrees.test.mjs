import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectState, TaskManager, startMapServer } from "../dist/index.js";
import { renderOverview, worktreeOverview } from "../dist/run/worktrees.js";
import { readRegistry, registerWorktree } from "../dist/run/worktree-registry.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The shop with two worktrees: `pricing` committed a change in Pricing; `wip` changed Pricing (not committed) and Orders. */
function shopWithWorktrees() {
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
  const pricing = `${root}-pricing`;
  const wip = `${root}-wip`;
  git(root, "worktree", "add", "-q", "-b", "feature/pricing", pricing);
  fs.appendFileSync(path.join(pricing, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(pricing, "commit", "-qam", "vat");
  git(root, "worktree", "add", "-q", "-b", "feature/wip", wip);
  fs.appendFileSync(path.join(wip, "src/pricing/index.ts"), "\nexport const tax = 1;\n");
  fs.appendFileSync(path.join(wip, "src/orders/index.ts"), "\nexport const note = 1;\n");
  fs.writeFileSync(path.join(wip, "src/orders/new.ts"), "export const fresh = 1;\n");
  return { root, pricing, wip };
}

test("worktrees: ahead of the main branch, the blocks each changes (committed or not), and where they meet", () => {
  const { root, pricing } = shopWithWorktrees();
  const overview = worktreeOverview(root, shopModel().blocks);
  assert.match(overview.base, /^main \([0-9a-f]{7}\)$/);
  const by = (branch) => overview.worktrees.find((worktree) => worktree.branch === branch);
  assert.equal(overview.worktrees.length, 3);
  assert.equal(by("main").current, true);
  assert.deepEqual([by("main").ahead, by("main").files], [0, []]);
  assert.deepEqual([by("feature/pricing").ahead, by("feature/pricing").files, by("feature/pricing").blocks], [1, ["src/pricing/index.ts"], ["src-pricing"]]);
  assert.deepEqual(by("feature/wip").files.sort(), ["src/orders/index.ts", "src/orders/new.ts", "src/pricing/index.ts"]);
  assert.deepEqual(by("feature/wip").blocks.sort(), ["src-orders", "src-pricing"]);
  assert.deepEqual(overview.shared, [{ block: "src-pricing", in: ["feature/pricing", "feature/wip"] }]);
  assert.equal(worktreeOverview(pricing, shopModel().blocks).worktrees.find((worktree) => worktree.current).branch, "feature/pricing", "from another checkout too");
  assert.match(renderOverview(overview), /\* main[^\n]*\n {4}no changes\n {2}feature\/pricing [^\n]*\n {4}\+1 commit\(s\), 1 file\(s\) changed; blocks: src-pricing[^]*src-pricing: feature\/pricing, feature\/wip/);
  assert.equal(worktreeOverview(copyFixture("shop"), shopModel().blocks), undefined, "outside git");
});

/** A project whose line of work is `release`, far ahead of an old `main`: two feature worktrees start from `release`. */
function releaseLine() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "old main");
  git(root, "checkout", "-q", "-b", "release");
  for (const file of ["src/pricing/index.ts", "src/orders/index.ts", "src/web/index.ts"]) {
    if (fs.existsSync(path.join(root, file))) fs.appendFileSync(path.join(root, file), "\nexport const later = 1;\n");
  }
  git(root, "commit", "-qam", "release moved on");
  const pricing = `${root}-pricing`;
  git(root, "worktree", "add", "-q", "-b", "feature/pricing", pricing, "release");
  fs.appendFileSync(path.join(pricing, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(pricing, "commit", "-qam", "vat");
  return { root, pricing };
}

test("worktrees: when the line of work is not `main`, a worktree is compared with it, not with the old main", () => {
  const { root, pricing } = releaseLine();
  const blocks = shopModel().blocks;
  const overview = worktreeOverview(root, blocks);
  const by = (branch) => overview.worktrees.find((worktree) => worktree.branch === branch);
  assert.deepEqual([by("release").ahead, by("release").files], [0, []], "the main checkout's own branch has no work of its own");
  assert.equal(by("release").comparedWith, "release");
  assert.deepEqual([by("feature/pricing").ahead, by("feature/pricing").files, by("feature/pricing").blocks], [1, ["src/pricing/index.ts"], ["src-pricing"]]);
  assert.deepEqual(overview.shared, []);
  assert.match(renderOverview(overview), /\(compared with release\)/);

  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const tasks = new TaskManager(new ProjectState(pricing), never);
  assert.deepEqual(tasks.collisions({ blocks: ["src-orders", "src-web"] }), [], "nobody works on those blocks: release itself is not a worktree at work");
});

test("worktrees: a base in the map's rules is the one everything is compared with", () => {
  const { root } = releaseLine();
  const blocks = shopModel().blocks;
  const byMain = worktreeOverview(root, blocks, "main");
  assert.match(byMain.base, /^main \(/);
  assert.ok(byMain.worktrees.find((worktree) => worktree.branch === "release").files.length > 1, "against the old main, release has moved a lot");
  assert.equal(worktreeOverview(root, blocks, "no-such-branch").worktrees.find((worktree) => worktree.branch === "release").ahead, 0, "an unknown base falls back to the usual choice");
});

test("worktrees: a worktree whose diff on a block is empty does not change that block (clean, reverted, or only a link)", () => {
  const { root } = releaseLine();
  const blocks = shopModel().blocks;
  const clean = `${root}-clean`;
  git(root, "worktree", "add", "-q", "-b", "feature/clean", clean, "release");
  const reverted = `${root}-reverted`;
  git(root, "worktree", "add", "-q", "-b", "feature/reverted", reverted, "release");
  const file = path.join(reverted, "src/orders/index.ts");
  const before = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, "\nexport const tmp = 1;\n");
  git(reverted, "commit", "-qam", "tmp");
  fs.writeFileSync(file, before);
  git(reverted, "commit", "-qam", "back");
  const linked = `${root}-linked`;
  git(root, "worktree", "add", "-q", "-b", "feature/linked", linked, "release");
  fs.symlinkSync(path.join(root, "src/db"), path.join(linked, "src/dblink"), process.platform === "win32" ? "junction" : "dir"); // like a junction a script made (Windows lets a person without developer mode make only that)
  const overview = worktreeOverview(root, blocks);
  const by = (branch) => overview.worktrees.find((worktree) => worktree.branch === branch);
  assert.deepEqual([by("feature/clean").files, by("feature/clean").blocks], [[], []]);
  assert.deepEqual([by("feature/reverted").files, by("feature/reverted").blocks], [[], []], "committed and taken back: the net diff is empty");
  assert.deepEqual([by("feature/linked").files, by("feature/linked").blocks], [[], []], "an untracked link is not work on a block");
  assert.deepEqual(overview.shared, []);
});

/** A task of its own in a worktree, Cantus's way, that waits for nothing. */
async function aTask(root, tasks, block = "src-db") {
  const running = tasks.start({ block, prompt: "Index orders\nand more", mode: "edit", isolation: "worktree" });
  // The files appear while git is still making the worktree: it is on the list only once that is done, and a stop before then leaves it off.
  for (let i = 0; i < 1000 && !readRegistry(root).some((entry) => entry.task === running.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(readRegistry(root).some((entry) => entry.task === running.id), "the worktree is on the list");
  tasks.stop(running.id);
  return running;
}

test("the tracked worktrees: what each is for, where it stands, and which can go", async () => {
  const { root } = shopWithWorktrees();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const tasks = new TaskManager(new ProjectState(root), never);
  const mine = await aTask(root, tasks);
  const state = () => tasks.trackedWorktrees().worktrees.find((worktree) => worktree.branch === mine.worktree.branch);
  assert.deepEqual(tasks.trackedWorktrees().worktrees.map((worktree) => worktree.branch), [mine.worktree.branch], "the other two were made by hand: not tracked");
  assert.deepEqual([state().state, state().prompt, state().session, state().ahead, state().uncommitted, state().blocks], ["empty", "Index orders", false, 0, 0, []]);

  fs.appendFileSync(path.join(mine.worktree.path, "src/db/client.ts"), "\nexport const x = 1;\n");
  assert.deepEqual([state().state, state().uncommitted, state().files, state().blocks], ["uncommitted", 1, 1, ["src-db"]]);
  git(mine.worktree.path, "commit", "-qam", "index");
  assert.deepEqual([state().state, state().ahead, state().behind], ["review", 1, 0]);
  fs.appendFileSync(path.join(root, "src/orders/index.ts"), "\nexport const later = 1;\n");
  git(root, "commit", "-qam", "main moves on");
  assert.equal(state().behind, 1, "behind: how far the main line has moved on");

  assert.deepEqual(await tasks.cleanupWorktrees(), { removed: [], left: [] }, "work not merged is never cleaned up");
  git(root, "merge", "-q", "--no-ff", "--no-edit", mine.worktree.branch);
  assert.equal(state().state, "merged");
  fs.writeFileSync(path.join(mine.worktree.path, "scratch.txt"), "x");
  assert.equal(state().state, "uncommitted", "merged, but with something not committed: not for cleaning");
  assert.deepEqual(await tasks.cleanupWorktrees(), { removed: [], left: [] });
  assert.ok(fs.existsSync(path.join(mine.worktree.path, "scratch.txt")));
  fs.rmSync(path.join(mine.worktree.path, "scratch.txt"));
  assert.deepEqual(await tasks.cleanupWorktrees(), { removed: [mine.worktree.branch], left: [] });
  assert.equal(fs.existsSync(mine.worktree.path), false);
  assert.equal(git(root, "branch", "--list", mine.worktree.branch), "");
  assert.deepEqual(readRegistry(root), []);
});

test("an entry whose folder is gone is an orphan: cleaning drops the entry and touches nothing else", async () => {
  const { root, pricing } = shopWithWorktrees();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const tasks = new TaskManager(new ProjectState(root), never);
  const mine = await aTask(root, tasks);
  fs.rmSync(mine.worktree.path, { recursive: true, force: true });
  assert.equal(tasks.trackedWorktrees().worktrees[0].state, "orphan");
  assert.deepEqual(await tasks.cleanupWorktrees(), { removed: [mine.worktree.branch], left: [] });
  assert.deepEqual(tasks.trackedWorktrees().worktrees, []);
  assert.ok(fs.existsSync(pricing), "a worktree made by hand is untouched");
});

test("the map's API lists the tracked worktrees and cleans them; cantus worktrees marks and cleans them too", async () => {
  const { root } = shopWithWorktrees();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const state = new ProjectState(root);
  const server = await startMapServer(state, { port: 0, pollInterval: 100, runner: never });
  try {
    const call = async (method, route) => (await fetch(new URL(route, server.url), { method, headers: { "x-cantus-token": server.token } })).json();
    const started = await (await fetch(new URL("api/tasks", server.url), { method: "POST", headers: { "x-cantus-token": server.token, "content-type": "application/json" }, body: JSON.stringify({ block: "src-db", prompt: "Index orders", mode: "edit", isolation: "worktree" }) })).json();
    for (let i = 0; i < 100 && !(await call("GET", "api/worktrees")).worktrees.length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = await call("GET", "api/worktrees");
    assert.equal(listed.worktrees.length, 1);
    assert.deepEqual([listed.worktrees[0].task, listed.worktrees[0].state], [started.id, "running"]);
    assert.match(listed.base, /^main \(/);
    assert.deepEqual(await call("POST", "api/worktrees/cleanup"), { removed: [], left: [] });
  } finally {
    await server.close();
  }
  const table = spawnSync(process.execPath, [cli, "worktrees", "-C", root], { encoding: "utf8" });
  assert.match(table.stdout, /made by Cantus for “Index orders”/);
  const none = spawnSync(process.execPath, [cli, "worktrees", "--clean", "-C", root], { encoding: "utf8" });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /Nothing to clean/);
});

test("cantus worktrees prints the table, or JSON", () => {
  const { root } = shopWithWorktrees();
  const table = spawnSync(process.execPath, [cli, "worktrees", "-C", root], { encoding: "utf8" });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /Worktrees of this repository, compared with main \(/);
  assert.match(table.stdout, /Changed in more than one checkout[^]*src-pricing: feature\/pricing, feature\/wip/);
  const json = JSON.parse(spawnSync(process.execPath, [cli, "worktrees", "--json", "-C", root], { encoding: "utf8" }).stdout);
  assert.equal(json.worktrees.length, 3);
  assert.equal(spawnSync(process.execPath, [cli, "worktrees", "-C", copyFixture("shop")], { encoding: "utf8" }).status, 1);
});

/** The two worktrees as Cantus's own tasks made them (on the list the map tracks), and a third made by hand in `web`. */
function madeByCantus() {
  const found = shopWithWorktrees();
  const base = git(found.root, "rev-parse", "main");
  for (const [branch, folder] of [["feature/pricing", found.pricing], ["feature/wip", found.wip]]) registerWorktree(found.root, { path: folder, branch, base, task: branch.slice(8), session: false, prompt: "A task", createdAt: new Date().toISOString() });
  const manual = `${found.root}-manual`;
  git(found.root, "worktree", "add", "-q", "-b", "feature/manual", manual);
  fs.appendFileSync(path.join(manual, "src/web/index.ts"), "\nexport const mine = 1;\n");
  return { ...found, manual };
}

test("a task about to start is told who else works on its blocks: a task, a specialist, a worktree Cantus made", () => {
  const { root } = madeByCantus();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const state = new ProjectState(root);
  const tasks = new TaskManager(state, never);
  assert.deepEqual(tasks.collisions({ block: "src-web" }), [], "a worktree made by hand is the person's own business: not reported");
  assert.deepEqual(tasks.collisions({ orchestrate: true }), [], "the whole project meets everyone's work: no warning");
  const kinds = (spec) => tasks.collisions(spec).map((c) => `${c.kind}:${c.what}:${c.blocks.join("+")}`).sort();
  assert.deepEqual(kinds({ block: "src-pricing" }), ["worktree:feature/pricing:src-pricing", "worktree:feature/wip:src-pricing"]);

  state.agents.start("a1", "block-src-pricing", ["src-pricing"]);
  const running = tasks.start({ block: "src-pricing", prompt: "Add VAT to prices\nand more", mode: "edit", isolation: "in-place" });
  const found = kinds({ block: "src-pricing" });
  assert.ok(found.includes("agent:block-src-pricing:src-pricing"));
  assert.ok(found.includes("task:Add VAT to prices:src-pricing"));
  assert.deepEqual(kinds({ blocks: ["src-orders", "src-web"] }), ["worktree:feature/wip:src-orders"]);
  tasks.stop(running.id);
  assert.ok(!kinds({ block: "src-pricing" }).some((entry) => entry.startsWith("task:")), "a stopped task is not in the way");
  state.agents.stop("a1");
});

test("the worktrees Cantus makes are on a list that follows them, and is gone with them", async () => {
  const { root } = shopWithWorktrees();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const tasks = new TaskManager(new ProjectState(root), never);
  const running = tasks.start({ block: "src-db", prompt: "Index orders", mode: "edit", isolation: "worktree" });
  for (let i = 0; i < 1000 && !readRegistry(root).length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const [entry] = readRegistry(root);
  assert.deepEqual([entry.branch, entry.task, entry.session, entry.prompt], [running.worktree.branch, running.id, false, "Index orders"]);
  assert.equal(entry.base, git(root, "rev-parse", "main"));
  assert.equal(fs.existsSync(path.join(git(root, "rev-parse", "--git-common-dir").replace(/^\.git$/, path.join(root, ".git")), "cantus-worktrees.json")), true, "next to the repository's own data, not in the project");
  assert.doesNotMatch(git(root, "status", "--porcelain"), /cantus-worktrees/, "never in the way of a commit");
  const overview = worktreeOverview(root, shopModel().blocks, undefined, readRegistry(root));
  assert.equal(overview.worktrees.find((worktree) => worktree.branch === running.worktree.branch).cantus.task, running.id);
  assert.equal(overview.worktrees.find((worktree) => worktree.current).cantus, undefined);
  tasks.stop(running.id);
  await tasks.discard(running.id);
  assert.deepEqual(readRegistry(root), []);
});

test("a task running in its own worktree is told once, as a task, not again as a worktree", async () => {
  const { root } = shopWithWorktrees();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const tasks = new TaskManager(new ProjectState(root), never);
  const running = tasks.start({ block: "src-db", prompt: "Index orders", mode: "edit", isolation: "worktree" });
  const client = path.join(running.worktree.path, "src/db/client.ts");
  for (let i = 0; i < 1000 && !fs.existsSync(client); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  fs.appendFileSync(client, "\nexport const x = 1;\n");
  assert.deepEqual(tasks.collisions({ block: "src-db" }).map((c) => c.kind), ["task"]);
  tasks.stop(running.id);
});
