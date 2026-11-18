import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectState, TaskManager } from "../dist/index.js";
import { assignDoc, loadModel, saveModel } from "../dist/model/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function shop({ rules, ignore = ".cantus/cache/\n" } = {}) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), ...(rules ? { agent: { worktree: rules } } : {}) }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ignore);
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
const manager = (root) => new TaskManager(new ProjectState(root), refuse);

test("a worktree for my own session: made with the rules, the task and briefing in a file, the lines to start it", async () => {
  const root = shop({ rules: { branch: "agent/{slug}" } });
  const tasks = manager(root);
  const task = tasks.prepare({ block: "src-pricing", prompt: "Add VAT to prices", model: "sonnet" });
  const done = await settled(task);
  assert.equal(done.status, "prepared", done.error);
  const wt = task.worktree;
  assert.equal(wt.branch, "agent/add-vat-to-prices");
  const file = path.join(task.session.folder, task.session.promptFile);
  assert.equal(fs.realpathSync(wt.path), fs.realpathSync(path.join(root, ".cantus/worktrees/add-vat-to-prices")), "inside .cantus, not in .git: Claude Code will not write there");
  assert.doesNotMatch(git(root, "status", "--porcelain"), /worktrees/, "the main checkout does not list the worktree as new");
  assert.equal(task.session.promptFile, ".cantus/cache/session-task.md");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /Task prepared from the Cantus map[^]*[Yy]our scope for this task is the block `src-pricing`[^]*Task: Add VAT to prices/);
  assert.deepEqual(task.session.commands, [`cd "${task.session.folder}"`, 'claude --model sonnet "Read .cantus/cache/session-task.md and do the task it describes."']);
  assert.equal(git(wt.path, "status", "--porcelain"), "", "the prompt file does not show up as a change");
  assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), "agent/add-vat-to-prices");
});

test("with core.autocrlf (the default of Git for Windows) the map copied into the worktree does not show up as modified", async () => {
  const root = shop();
  git(root, "config", "core.autocrlf", "true");
  // Cantus writes the map with LF; the worktree's checkout gets CRLF.
  const task = await settled(manager(root).prepare({ block: "src-pricing", prompt: "Add VAT to prices" }));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(git(task.worktree.path, "status", "--porcelain"), "");
  assert.match(fs.readFileSync(path.join(task.worktree.path, ".cantus/model.json"), "utf8"), /\r\n/, "the checkout's own file is left as it is");
});

test("without a .gitignore line for the cache, Cantus's own keeps the prompt file out, and out of the way of a merge", async () => {
  const root = shop({ ignore: "" });
  const tasks = manager(root);
  const task = await settled(tasks.prepare({ block: "src-pricing", prompt: "Add VAT" }));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(git(task.worktree.path, "check-ignore", ".cantus/cache/session-task.md"), ".cantus/cache/session-task.md");
  fs.appendFileSync(path.join(task.session.folder, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(task.worktree.path, "commit", "-qam", "vat");
  await tasks.merge(task.id);
  assert.equal(task.status, "merged");
  assert.match(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /vat = 0\.22/);
  assert.equal(fs.existsSync(task.worktree.path), false);
});

test("merging or discarding never throws away work that was not committed", async () => {
  const root = shop();
  const tasks = manager(root);
  const task = await settled(tasks.prepare({ block: "src-pricing", prompt: "Add VAT" }));
  await assert.rejects(tasks.merge(task.id), /Nothing is committed on cantus\/task-/);
  const pricing = path.join(task.session.folder, "src/pricing/index.ts");
  fs.appendFileSync(pricing, "\nexport const vat = 0.22;\n");
  await assert.rejects(tasks.merge(task.id), /changes that are not committed \(src\/pricing\/index\.ts\)/);
  await assert.rejects(tasks.discard(task.id), /discarding would delete them/);
  assert.equal(fs.existsSync(task.worktree.path), true);
  git(task.worktree.path, "commit", "-qam", "vat");
  fs.writeFileSync(path.join(task.session.folder, "scratch.txt"), "x");
  await assert.rejects(tasks.merge(task.id), /scratch\.txt/);
  fs.rmSync(path.join(task.session.folder, "scratch.txt"));
  await tasks.merge(task.id);
  assert.equal(task.status, "merged");

  const other = await settled(tasks.prepare({ block: "src-web", prompt: "Nothing" }));
  await tasks.discard(other.id);
  assert.equal(other.status, "discarded");
  assert.equal(fs.existsSync(other.worktree.path), false);
});

test("the setup commands of the rules need the go-ahead here too, and run before the lines are given", async () => {
  const root = shop({ rules: { setup: [`node -e "require('fs').writeFileSync('prepared.txt','1')"`] } });
  const tasks = manager(root);
  assert.throws(() => tasks.prepare({ block: "src-pricing", prompt: "x" }), /run commands on this machine/);
  const task = await settled(tasks.prepare({ block: "src-pricing", prompt: "x", confirmSetup: true }));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(fs.readFileSync(path.join(task.session.folder, "prepared.txt"), "utf8"), "1");
  fs.appendFileSync(path.join(task.session.folder, "src/pricing/index.ts"), "\nexport const a = 1;\n");
  git(task.worktree.path, "commit", "-qam", "a");
  await tasks.merge(task.id); // what setup left is not "work that was not committed"
  assert.equal(task.status, "merged");
});

test("the plan to build can be prepared for a session: the lead of the new worktree gets the whole plan, and nothing is run from the map", async () => {
  // Nothing planned: it does not start, as for a task.
  assert.throws(() => manager(shop()).prepare({ build: true, prompt: "" }), /Nothing planned/);
  const model = shopModel();
  model.blocks.push({ id: "src-wishlist", name: "Wishlist", layer: "domain", include: ["src/wishlist"], description: "Saved products." });
  model.dependencies.push({ from: "src-wishlist", to: "src-orders" });
  const root = shop();
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  git(root, "commit", "-qam", "sketch");
  const task = await settled(manager(root).prepare({ build: true, prompt: "Use plain fetch." }));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(task.build, true);
  const text = fs.readFileSync(path.join(task.session.folder, task.session.promptFile), "utf8");
  assert.match(text, /Task: build the plan\./);
  assert.match(text, /Notes from the developer: Use plain fetch\./);
  assert.match(text, /### Wave 1\n\n- `src-wishlist` Wishlist/);
  assert.match(text, /You are the lead of this worktree/);
  assert.match(text, /The task is the whole map's plan, skeleton included/);
  assert.doesNotMatch(text, /Work in the blocks of the scope above/, "the skeleton and the new blocks' folders are the work, not outside it");
  assert.doesNotMatch(text, /Before you delegate/, "the whole plan is built wave by wave, with its own way of working");
  assert.match(text, /After a separate verification, give a confirmed finding back to the specialist/, "the correction rule is for every lead");
});

test("the task file asks the lead to write the criteria and the pieces before it delegates, and to send corrections back to the specialist", async () => {
  const task = await settled(manager(shop()).prepare({ block: "src-pricing", prompt: "Add VAT to prices" }));
  const text = fs.readFileSync(path.join(task.session.folder, task.session.promptFile), "utf8");
  const section = text.match(/## Before you delegate\n\n([^]*?)\n\n## When you are done/);
  assert.ok(section, "the section is between who the lead is and what it does when it is done");
  assert.match(text, /## Who you are[^]*## Before you delegate[^]*## When you are done/);
  assert.match(section[1], /\.cantus\/cache\/session-plan\.md/);
  assert.match(section[1], /acceptance criteria[^]*one piece per block, with the exact signatures[^]*what must not be touched/);
  assert.match(section[1], /few lines you can write yourself/, "the exception of a few lines stays");
  const correction = text.match(/After a separate verification[^\n]*/);
  assert.ok(correction);
  const words = (value) => value.split(/\s+/).filter(Boolean).length;
  assert.ok(words(section[1]) + words(correction[0]) < 120, `${words(section[1]) + words(correction[0])} words added`);
  assert.equal(git(task.worktree.path, "check-ignore", ".cantus/cache/session-plan.md"), ".cantus/cache/session-plan.md", "git ignores the plan: it never reaches the branch");
});

test("a path rule wins over the default place, and {repo} is the repository folder", async () => {
  const root = shop({ rules: { path: "../{repo}-mine/{slug}" } });
  const task = await settled(manager(root).prepare({ block: "src-pricing", prompt: "Add VAT" }));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(fs.realpathSync(task.worktree.path), fs.realpathSync(path.join(path.dirname(root), `${path.basename(root)}-mine`, "add-vat")));
});

test("a folder that a terminal would read as a command is refused for the lines of a session, with the preview saying so", () => {
  const root = shop({ rules: { path: "../wt-$(touch pwned)/{slug}" } });
  assert.throws(() => manager(root).prepare({ block: "src-pricing", prompt: "Add VAT" }), /agent\.worktree\.path/);
  assert.throws(() => manager(root).previewWorktree({ block: "src-pricing", prompt: "Add VAT", session: true }), /agent\.worktree\.path/);
  assert.doesNotThrow(() => manager(root).previewWorktree({ block: "src-pricing", prompt: "Add VAT" }), "a task Cantus runs itself never passes the folder to a shell");
});

test("a person's own CLAUDE.md and AGENTS.md (skip-worktree in the checkout) reach the worktree with the same mark, out of the diff", async () => {
  const root = shop();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Team notes\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Team agents\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "notes");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# My own notes\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# My own agents\n");
  git(root, "update-index", "--skip-worktree", "CLAUDE.md");
  git(root, "update-index", "--assume-unchanged", "AGENTS.md");
  const task = await settled(manager(root).prepare({ block: "src-pricing", prompt: "Add VAT" }));
  assert.equal(task.status, "prepared", task.error);
  const wt = task.worktree.path;
  assert.equal(fs.readFileSync(path.join(wt, "CLAUDE.md"), "utf8"), "# My own notes\n", "the session reads the person's own notes");
  assert.equal(git(wt, "status", "--porcelain"), "", "git in the worktree does not see them as changed");
  assert.match(git(wt, "ls-files", "-v", "CLAUDE.md"), /^S /);
  assert.match(git(wt, "ls-files", "-v", "AGENTS.md"), /^h /);
  git(wt, "add", "-A");
  assert.equal(git(wt, "diff", "--cached", "--name-only"), "", "an `add -A` in the session leaves them out");
});

test("in a session of my own a tracked note the checkout only changed stays as committed, and the log says so", async () => {
  const root = shop();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Team notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "notes");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Changed, not committed\n");
  const task = await settled(manager(root).prepare({ block: "src-pricing", prompt: "Add VAT" }));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(fs.readFileSync(path.join(task.worktree.path, "CLAUDE.md"), "utf8"), "# Team notes\n");
  assert.equal(git(task.worktree.path, "status", "--porcelain"), "", "nothing an `add -A` would put in the person's pull request");
  assert.ok(task.events.some((event) => /Left as committed in the worktree[^]*CLAUDE\.md/.test(event.text)));
});

test("the branch the person named, and where it starts, win over the map's rule; a taken branch or an option is refused", async () => {
  const root = shop({ rules: { branch: "agent/{slug}" } });
  git(root, "branch", "release");
  git(root, "checkout", "-q", "release");
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const onRelease = 1;\n");
  git(root, "commit", "-qam", "release only");
  git(root, "checkout", "-q", "main");
  const tasks = manager(root);
  const task = await settled(tasks.prepare({ block: "src-pricing", prompt: "Add VAT", branch: "fix/1234-totals", from: "release" }));
  assert.equal(task.status, "prepared", task.error);
  assert.equal(git(task.worktree.path, "rev-parse", "--abbrev-ref", "HEAD"), "fix/1234-totals");
  assert.equal(git(task.worktree.path, "rev-parse", "HEAD"), git(root, "rev-parse", "release"), "it starts from the branch named");
  assert.equal(tasks.previewWorktree({ block: "src-pricing", prompt: "Add VAT", branch: "fix/other", session: true }).branch, "fix/other");
  assert.throws(() => tasks.prepare({ block: "src-pricing", prompt: "x", branch: "release" }), /exists already/);
  assert.throws(() => tasks.prepare({ block: "src-pricing", prompt: "x", branch: "--force" }), /cannot start with "-"/);
  assert.throws(() => tasks.prepare({ block: "src-pricing", prompt: "x", from: "nowhere" }), /not a branch, tag or commit/);
});

async function until(check) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

test("from a session's tools the rules' commands wait for the person on the map: allowed they run, denied nothing is made", async () => {
  const root = shop({ rules: { setup: [`node -e "require('fs').writeFileSync('prepared.txt','1')"`] } });
  const tasks = manager(root);
  const task = tasks.prepare({ block: "src-pricing", prompt: "Add VAT", confirmOnMap: true });
  await until(() => task.approvals.length);
  assert.equal(task.status, "waiting");
  assert.equal(task.approvals[0].tool, "WorktreeSetup");
  assert.match(task.approvals[0].summary, /prepared\.txt/, "the person sees the exact command");
  assert.equal(fs.existsSync(task.worktree.path), false, "nothing is made before the go-ahead");
  tasks.decide(task.id, task.approvals[0].id, { allow: true });
  const done = await settled(task);
  assert.equal(done.status, "prepared", done.error);
  assert.equal(fs.readFileSync(path.join(task.session.folder, "prepared.txt"), "utf8"), "1");

  const other = tasks.prepare({ block: "src-web", prompt: "Nothing", confirmOnMap: true });
  await until(() => other.approvals.length);
  tasks.decide(other.id, other.approvals[0].id, { allow: false });
  await settled(other);
  assert.equal(other.status, "stopped");
  assert.match(other.result, /did not run/);
  assert.equal(fs.existsSync(other.worktree.path), false);
  assert.equal(git(root, "branch", "--list", other.worktree.branch), "", "no branch either");
});

test("the task file asks the lead for domain notes before the commit: little, in .cantus/domain, registered, only where there is something to say", async () => {
  const task = await settled(manager(shop()).prepare({ block: "src-pricing", prompt: "Add VAT to prices" }));
  const text = fs.readFileSync(path.join(task.session.folder, task.session.promptFile), "utf8");
  const done = text.slice(text.indexOf("## When you are done"));
  const [notes, commit, check, report] = [1, 2, 3, 4].map((n) => done.match(new RegExp(`^${n}\\. .*`, "m"))?.[0]);
  assert.ok(notes && commit && check && report, "four steps");
  assert.match(notes, /at most three lines to `\.cantus\/domain\/<block-or-group-id>\.md`/);
  assert.match(notes, /`assign_doc`/);
  for (const heading of ["Invariants", "Decisions", "Pitfalls", "How to test here"]) assert.match(notes, new RegExp(`\`${heading}\``));
  assert.match(notes, /files it rests on/);
  assert.match(notes, /"Nothing to add" is a valid answer/);
  assert.match(notes, /about 400 words/);
  assert.match(notes, /confirmed finding, or a correction from the person, becomes a line under `Pitfalls`/);
  assert.match(commit, /notes included/, "the notes go in the commit of the work");
  assert.ok(notes.split(/\s+/).length < 120, `${notes.split(/\s+/).length} words`);
});

test("a domain note the lead wrote: the briefing of its block carries it, the reviewer reads it next to the code, the merge takes it, `cantus notes` leaves it", async () => {
  const root = shop();
  const tasks = manager(root);
  const task = await settled(tasks.prepare({ block: "src-pricing", prompt: "Add VAT to prices" }));
  const wt = task.session.folder;
  // What the lead does: the change, a note in .cantus/domain, registered as a document of the block, all committed.
  fs.appendFileSync(path.join(wt, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  fs.mkdirSync(path.join(wt, ".cantus/domain"), { recursive: true });
  const note = "## Invariants\n- Prices are in cents everywhere. (src/pricing/index.ts)\n";
  fs.writeFileSync(path.join(wt, ".cantus/domain/src-pricing.md"), note);
  saveModel(wt, assignDoc(loadModel(wt), { path: ".cantus/domain/src-pricing.md", blocks: ["src-pricing"], description: "Domain notes of pricing" }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "-C", wt], { encoding: "utf8" });

  // Not committed yet: the reviewer still reads it (it is under .cantus/, which the changes leave out).
  assert.match(run("verify", "--dry-run", "--no-tests").stdout, /Domain notes the author wrote or changed[^]*\+## Invariants\n\+- Prices are in cents everywhere/);
  git(wt, "add", "src", ".cantus/model.json", ".cantus/domain");
  git(wt, "commit", "-qm", "vat and a note");

  const briefing = run("context", "src-pricing").stdout;
  assert.match(briefing, /## Notes for this block[^]*<doc path="\.cantus\/domain\/src-pricing\.md" description="Domain notes of pricing">\n## Invariants\n- Prices are in cents everywhere/);
  assert.equal(run("context", "src-orders").stdout.includes("Prices are in cents"), false, "a block it is not assigned to does not get it");

  const verify = run("verify", "--dry-run", "--no-tests").stdout;
  assert.match(verify, /Domain notes the author wrote or changed[^]*diff --git a\/\.cantus\/domain\/src-pricing\.md[^]*\+- Prices are in cents everywhere/, "a tracked note's diff is given, though .cantus is left out of the changes");
  assert.match(verify, /Notes under `\.cantus\/domain\/` that the author wrote or changed[^]*check them against it[^]*`Invariants`/);
  assert.match(verify, /## Changed files[^]*`src\/pricing\/index\.ts`/);

  await tasks.merge(task.id);
  assert.equal(task.status, "merged", task.error);
  assert.equal(task.cleanupError, undefined, "a tracked note and the map's change are the work, not Cantus's rebuilt output");
  assert.equal(fs.readFileSync(path.join(root, ".cantus/domain/src-pricing.md"), "utf8"), note);
  assert.deepEqual(loadModel(root).docs.map((doc) => doc.path), [".cantus/domain/src-pricing.md"]);
  const notes = spawnSync(process.execPath, [cli, "notes", "-C", root], { encoding: "utf8" });
  assert.equal(notes.status, 0, notes.stderr);
  assert.equal(fs.readFileSync(path.join(root, ".cantus/domain/src-pricing.md"), "utf8"), note, "`cantus notes` writes the block notes, not these");
  assert.deepEqual(loadModel(root).docs.map((doc) => doc.path), [".cantus/domain/src-pricing.md"]);
});
