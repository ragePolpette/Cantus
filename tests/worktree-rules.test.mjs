import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectState, TaskManager, validateModel } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The shop in git with the given worktree rules in its map; `files` are added before the first commit, `after` once it is made. */
function shopWith(rules, { files = {}, ignore = ".cantus/cache/\n.cantus/*.log\n", after = {}, branch } = {}) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), ...(rules ? { agent: { worktree: rules } } : {}) }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ignore);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  if (branch) git(root, "checkout", "-q", "-b", branch);
  for (const [file, content] of Object.entries(after)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const idle = () => {
  const runs = [];
  const runner = (request) => {
    const session = { request, async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { yield { type: "result", ok: true, text: "done" }; })() };
    runs.push(session);
    return session;
  };
  return { runner, runs };
};

async function finished(task) {
  for (let i = 0; i < 1000; i++) {
    if (task.finishedAt) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`The task did not finish: ${task.status} ${task.error ?? ""}`);
}

const start = (root, spec = {}) => {
  const { runner, runs } = idle();
  const tasks = new TaskManager(new ProjectState(root), runner);
  return { tasks, runs, run: (more = {}) => tasks.start({ block: "src-pricing", prompt: "Add VAT to prices", mode: "edit", isolation: "worktree", ...spec, ...more }) };
};

test("a worktree starts from the main branch, not from the branch the person is on", async () => {
  const root = shopWith(undefined, { branch: "feature/wip" });
  fs.writeFileSync(path.join(root, "wip.txt"), "unfinished\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "wip");
  const { run } = start(root);
  const task = run();
  assert.equal(task.worktree.base, git(root, "rev-parse", "main"));
  assert.match(task.worktree.baseLabel, /^main \([0-9a-f]{7}\)$/);
  await finished(task);
  assert.equal(fs.existsSync(path.join(task.worktree.path, "wip.txt")), false, "the work in progress is not in it");
  assert.ok(task.events.some((event) => /Worktree cantus\/task-[0-9a-f]+ at .*, from main \(/.test(event.text)));
});

test("base: HEAD, or any branch, tag or commit; one that does not exist is refused", async () => {
  const root = shopWith({ base: "HEAD" }, { branch: "feature/wip" });
  fs.writeFileSync(path.join(root, "wip.txt"), "unfinished\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "wip");
  const head = start(root).run();
  assert.equal(head.worktree.base, git(root, "rev-parse", "HEAD"));
  await finished(head);

  const tagged = shopWith({ base: "v1" });
  git(tagged, "tag", "v1");
  assert.equal(start(tagged).run().worktree.base, git(tagged, "rev-parse", "v1"));
  assert.throws(() => start(shopWith({ base: "nope" })).run(), /agent\.worktree\.base "nope" is not a branch, tag or commit/);
});

test("branch and folder templates; a name that is taken gets -2", async () => {
  const root = shopWith(undefined);
  const folder = `${path.basename(root)}-wt`;
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), agent: { worktree: { branch: "agent/{block}/{slug}", path: `../${folder}/{slug}` } } }, null, 2));
  const { run } = start(root);
  const first = run();
  assert.equal(first.worktree.branch, "agent/src-pricing/add-vat-to-prices");
  assert.equal(first.worktree.path, path.join(path.dirname(root), folder, "add-vat-to-prices"), "relative to the repository's top folder");
  await finished(first);
  assert.ok(fs.existsSync(path.join(first.worktree.path, "src/pricing/index.ts")));
  assert.equal(git(first.worktree.path, "rev-parse", "--abbrev-ref", "HEAD"), "agent/src-pricing/add-vat-to-prices");
  const second = run();
  assert.equal(second.worktree.branch, "agent/src-pricing/add-vat-to-prices-2");
  assert.equal(second.worktree.path, `${first.worktree.path}-2`);
  await finished(second);
  assert.throws(() => start(shopWith({ branch: "bad branch~" })).run(), /not a valid branch name/);
});

test("copy and .worktreeinclude bring in what git ignores; link makes a junction that is never committed and never followed", async () => {
  const root = shopWith(
    { copy: [".env"], link: ["packages"] },
    { ignore: ".cantus/cache/\n.env\n.env.local\n", files: { ".worktreeinclude": ".env.local\n" }, after: { ".env": "KEY=1\n", ".env.local": "LOCAL=1\n", "packages/lib/a.txt": "static\n" } },
  );
  const { run, tasks } = start(root);
  const task = run();
  await finished(task);
  const wt = task.worktree.path;
  assert.equal(fs.readFileSync(path.join(wt, ".env"), "utf8"), "KEY=1\n");
  assert.equal(fs.readFileSync(path.join(wt, ".env.local"), "utf8"), "LOCAL=1\n", ".worktreeinclude is read");
  assert.ok(fs.lstatSync(path.join(wt, "packages")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(wt, "packages/lib/a.txt"), "utf8"), "static\n");
  assert.ok(task.worktree.carried.includes("packages"), "the link stays out of the task's commit");
  assert.ok(task.events.some((event) => /Copied into the worktree: .env, .env.local/.test(event.text)));
  assert.ok(task.events.some((event) => /Linked to the project's own: packages/.test(event.text)));
  assert.equal(git(wt, "ls-files", "packages"), "");

  await tasks.discard(task.id);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.readFileSync(path.join(root, "packages/lib/a.txt"), "utf8"), "static\n", "the project's own files are still there");
});

test("copy and link name paths inside the project; one that is missing or already in the worktree is said, not an error", async () => {
  assert.deepEqual(validateModel({ ...shopModel(), agent: { worktree: { copy: ["../secret"], link: ["/etc"], setup: [""], base: 3 } } }).filter((problem) => /worktree/.test(problem)), [
    "agent.worktree.base must be a non-empty string",
    "agent.worktree.setup must be a list of strings",
    'agent.worktree.copy "../secret" must be a path inside the project',
    'agent.worktree.link "/etc" must be a path inside the project',
  ]);
  const root = shopWith({ copy: ["missing.txt", "package.json"] });
  const task = start(root).run();
  await finished(task);
  assert.ok(task.events.some((event) => /"missing\.txt" is not in the project/.test(event.text)));
  assert.ok(task.events.some((event) => /"package\.json" is already in the worktree/.test(event.text)));
});

test("setup commands run in the new worktree, and only after the person confirmed them", async () => {
  const root = shopWith({ setup: [`node -e "require('fs').writeFileSync('setup-ran.txt', process.env.CANTUS_BRANCH)"`] });
  const { run } = start(root);
  assert.throws(() => run(), /run commands on this machine before the task starts: `node -e .*`\. Confirm to run them/);
  assert.equal(git(root, "worktree", "list").split("\n").length, 1, "nothing was made");
  const task = run({ confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "done");
  assert.equal(fs.readFileSync(path.join(task.worktree.path, "setup-ran.txt"), "utf8"), task.worktree.branch);
  assert.deepEqual(task.worktree.setup.length, 1);
});

test("a failing setup command fails the task with its output, and the worktree can be discarded", async () => {
  const root = shopWith({ setup: [`node -e "console.error('no network'); process.exit(3)"`, `node -e "require('fs').writeFileSync('never.txt','')"`] });
  const { run, tasks } = start(root);
  const task = run({ confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "failed");
  assert.match(task.error, /Setup command failed: node -e .*\nno network/);
  assert.equal(fs.existsSync(path.join(task.worktree.path, "never.txt")), false, "the next command did not run");
  await tasks.discard(task.id);
  assert.equal(fs.existsSync(task.worktree.path), false);
});

test("previewWorktree says what a task would get, and makes nothing", () => {
  const root = shopWith({ branch: "agent/{slug}", copy: [".env"], setup: ["pnpm install"] });
  const { tasks } = start(root);
  const plan = tasks.previewWorktree({ block: "src-pricing", prompt: "Add VAT" });
  assert.equal(plan.branch, "agent/add-vat");
  assert.deepEqual(plan.setup, ["pnpm install"]);
  assert.deepEqual(plan.copy, [".env"]);
  assert.match(plan.baseLabel, /^main \(/);
  assert.equal(git(root, "worktree", "list").split("\n").length, 1);
  assert.equal(git(root, "branch", "--list", "agent/*"), "");
});

test("what setup leaves behind stays out of the task's commit", async () => {
  const root = shopWith({ setup: [`node -e "require('fs').mkdirSync('deps/x', {recursive: true}); require('fs').writeFileSync('deps/x/a.js', '1')"`] });
  const runs = [];
  const runner = (request) => {
    runs.push(request);
    return {
      async setPermissionMode() {},
      [Symbol.asyncIterator]: () => (async function* () {
        fs.appendFileSync(path.join(request.cwd, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
        yield { type: "result", ok: true, text: "done" };
      })(),
    };
  };
  const tasks = new TaskManager(new ProjectState(root), runner, { policy: { check: () => ({ allow: true }) } });
  const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit", isolation: "worktree", confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "done", task.error);
  assert.deepEqual(task.changedFiles, ["src/pricing/index.ts"]);
  assert.ok(task.worktree.carried.includes("deps"));
  assert.equal(git(task.worktree.path, "ls-files", "deps"), "");
  assert.ok(fs.existsSync(path.join(task.worktree.path, "deps/x/a.js")), "still there for the agent");
});

test("CLI: cantus task --worktree asks for the setup commands to be agreed, and --run-setup agrees", () => {
  const root = shopWith({ setup: [`node -e "require('fs').writeFileSync('setup-ran.txt','1')"`] });
  const runnerFile = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-runner-")), "runner.mjs");
  fs.writeFileSync(runnerFile, 'export default () => ({ [Symbol.asyncIterator]: () => (async function* () { yield { type: "result", ok: true, text: "done" }; })(), async setPermissionMode() {} });\n');
  const run = (...extra) => spawnSync(process.execPath, [cli, "task", "src-pricing", "Add VAT", "--worktree", "--runner", runnerFile, "-C", root, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const refused = run();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /The map's worktree rules run commands on this machine:\n  node -e .*\nAdd --run-setup to agree/);
  assert.equal(git(root, "worktree", "list").split("\n").length, 1);
  const agreed = run("--run-setup");
  assert.equal(agreed.status, 0, agreed.stderr);
  assert.match(agreed.stderr, /· Setup: node -e/);
});

const SCRIPT = `#!/bin/bash
name="$1"; branch="$2"
echo "making $name on $branch from $CANTUS_BASE_REF"
git worktree add -q -b "$branch" "$CANTUS_PATH" "$CANTUS_BASE_REF" >&2
ln -s "$CANTUS_ROOT/packages" "$CANTUS_PATH/packages"
echo "$name" > "$CANTUS_PATH/made-by-script.txt"
echo "$CANTUS_TASK $CANTUS_BLOCKS" > "$CANTUS_PATH/env.txt"
echo "$CANTUS_PATH"
`;

function shopWithScript(extra = {}, script = SCRIPT) {
  return shopWith({ script: "scripts/new-worktree.sh", ...extra }, { files: { "scripts/new-worktree.sh": script }, after: { "packages/lib/a.txt": "static\n" }, ignore: ".cantus/cache/\n" });
}

test("a worktree script makes the worktree: it gets the name and the branch, and its folder is found from the last line", async () => {
  const root = shopWithScript({ branch: "agent/{slug}" });
  const { run, tasks } = start(root);
  assert.throws(() => run(), /run commands on this machine[^]*`bash [^`]*scripts\/new-worktree\.sh add-vat-to-prices agent\/add-vat-to-prices`/, "agreed to every time");
  const task = run({ confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "done", task.error);
  const wt = task.worktree;
  assert.equal(wt.branch, "agent/add-vat-to-prices");
  assert.equal(fs.realpathSync(wt.path), fs.realpathSync(path.join(root, ".git/cantus-worktrees", task.id)));
  assert.equal(fs.readFileSync(path.join(wt.path, "made-by-script.txt"), "utf8").trim(), "add-vat-to-prices");
  assert.equal(fs.readFileSync(path.join(wt.path, "env.txt"), "utf8").trim(), `${task.id} src-pricing`);
  assert.equal(wt.base, git(root, "rev-parse", "main"));
  assert.ok(task.events.some((event) => /making add-vat-to-prices on agent\/add-vat-to-prices from main/.test(event.text)));
  assert.ok(wt.carried.includes("made-by-script.txt") && wt.carried.includes("packages"), "what the script left stays out of the task's commit");

  await tasks.discard(task.id);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(fs.readFileSync(path.join(root, "packages/lib/a.txt"), "utf8"), "static\n", "the link the script made was taken out first: the project's files are safe");
  assert.equal(git(root, "branch", "--list", "agent/*"), "");
});

test("a worktree script that prints no folder is found by its branch; copy, link and setup are left to it", async () => {
  const quiet = SCRIPT.replace('echo "$CANTUS_PATH"\n', "");
  const root = shopWithScript({ copy: [".env"], setup: ["echo never"] }, quiet);
  const { run, tasks } = start(root);
  const plan = tasks.previewWorktree({ block: "src-pricing", prompt: "Add VAT to prices" });
  assert.equal(plan.script, "scripts/new-worktree.sh");
  assert.equal(plan.name, "add-vat-to-prices");
  assert.deepEqual([plan.copy, plan.link, plan.setup], [[], [], []]);
  const task = run({ confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "done", task.error);
  assert.equal(fs.realpathSync(task.worktree.path), fs.realpathSync(path.join(root, ".git/cantus-worktrees", task.id)));
  assert.equal(task.events.some((event) => /never/.test(event.text)), false);
});

test("a worktree script that fails, is missing, or points elsewhere fails the task with a reason", async () => {
  const failing = shopWithScript({}, '#!/bin/bash\necho "no disk" >&2\nexit 4\n');
  let task = start(failing).run({ confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "failed");
  assert.match(task.error, /The worktree script failed: .*new-worktree\.sh\nno disk/);

  const missing = shopWith({ script: "nope.sh" });
  task = start(missing).run({ confirmSetup: true });
  await finished(task);
  assert.match(task.error, /nope\.sh does not exist \(agent\.worktree\.script\)/);

  const elsewhere = shopWithScript({}, '#!/bin/bash\necho /tmp\n');
  task = start(elsewhere).run({ confirmSetup: true });
  await finished(task);
  assert.match(task.error, /printed no folder and no worktree has the branch|is not a worktree of this repository/);
});

// The shape of a real one (a .ps1 with named parameters, a worktree beside the repository, a link three folders down,
// "Worktree pronto: ..." as its last line, and a remove script that wants -Name and -Force), as bash.
const NAMED = `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -Branch) branch="$2"; shift 2;; -BaseBranch) base="$2"; shift 2;; *) echo "unexpected $1" >&2; exit 9;; esac; done
leaf="\${branch##*/}"
wt="$CANTUS_ROOT-$leaf"
git worktree add -q -b "$branch" "$wt" "$base" >&2
mkdir -p "$wt/webroot/api"
rm -rf "$wt/webroot/api/packages"
ln -s "$CANTUS_ROOT/packages" "$wt/webroot/api/packages"
echo "Worktree pronto: $wt  (branch $branch da $base)"
`;
const REMOVE = `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -Name) name="$2"; shift 2;; -Force) force=1; shift;; *) echo "unexpected $1" >&2; exit 9;; esac; done
[ -n "$force" ] || { echo "no -Force" >&2; exit 8; }
wt="$(git worktree list --porcelain | awk -v b="refs/heads/$name" '/^worktree /{p=$2} $0=="branch " b {print p}')"
[ -n "$wt" ] || { echo "no worktree for $name" >&2; exit 7; }
rm -f "$wt/webroot/api/packages"
echo removed > "$CANTUS_ROOT/remove-ran.txt"
git worktree remove --force "$wt"
`;

test("a script with named parameters and its own remove script: scriptArgs, the folder found by branch, links three folders down, removeScript", async () => {
  const root = shopWithScript(
    { branch: "agent/{slug}", scriptArgs: ["-Branch", "{branch}", "-BaseBranch", "{baseRef}"], removeScript: "scripts/remove.sh", removeArgs: ["-Name", "{branch}", "-Force"] },
    NAMED,
  );
  fs.writeFileSync(path.join(root, "scripts/remove.sh"), REMOVE);
  const { run, tasks } = start(root);
  assert.match(tasks.previewWorktree({ block: "src-pricing", prompt: "Add VAT to prices" }).scriptLine, /^bash [^]*scripts\/new-worktree\.sh -Branch agent\/add-vat-to-prices -BaseBranch main$/);
  assert.throws(() => run(), /`bash [^`]*scripts\/new-worktree\.sh -Branch agent\/add-vat-to-prices -BaseBranch main`/);
  const task = run({ confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "done", task.error);
  const wt = task.worktree;
  assert.equal(fs.realpathSync(wt.path), fs.realpathSync(`${root}-add-vat-to-prices`), "found by its branch: the last line is not a folder");
  assert.equal(wt.base, git(root, "rev-parse", "main"));
  await tasks.discard(task.id);
  assert.equal(fs.readFileSync(path.join(root, "remove-ran.txt"), "utf8").trim(), "removed");
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(fs.readFileSync(path.join(root, "packages/lib/a.txt"), "utf8"), "static\n");
  assert.equal(git(root, "branch", "--list", "agent/*"), "");
});

test("a link three folders down is taken out before the worktree goes, with no remove script", async () => {
  const root = shopWithScript({ branch: "agent/{slug}", scriptArgs: ["-Branch", "{branch}", "-BaseBranch", "{baseRef}"] }, NAMED);
  const { run, tasks } = start(root);
  const task = run({ confirmSetup: true });
  await finished(task);
  assert.equal(task.status, "done", task.error);
  await tasks.discard(task.id);
  assert.equal(fs.readFileSync(path.join(root, "packages/lib/a.txt"), "utf8"), "static\n", "the project's files are safe");
});

test("a remove script that fails stops the removal and says why", async () => {
  const root = shopWithScript({ branch: "agent/{slug}", scriptArgs: ["-Branch", "{branch}", "-BaseBranch", "{baseRef}"], removeScript: "scripts/remove.sh", removeArgs: ["-Name", "{branch}"] }, NAMED);
  fs.writeFileSync(path.join(root, "scripts/remove.sh"), REMOVE);
  const { run, tasks } = start(root);
  const task = run({ confirmSetup: true });
  await finished(task);
  await assert.rejects(() => tasks.discard(task.id), /The remove script failed: .*remove\.sh\nno -Force/);
  assert.ok(fs.existsSync(task.worktree.path), "nothing removed behind its back");
  fs.rmSync(task.worktree.path, { recursive: true, force: true });
});

test("how a script is started depends on what it is", async () => {
  const { scriptCommand, foundWorktree } = await import("../dist/run/worktree-rules.js");
  assert.deepEqual(scriptCommand("C:\\w\\new.ps1", ["a", "b"], "win32", () => false), { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\w\\new.ps1", "a", "b"] });
  assert.equal(scriptCommand("C:\\w\\new.ps1", ["a", "b"], "win32", () => true).file, "pwsh");
  assert.equal(scriptCommand("/w/new.ps1", [], "linux").file, "pwsh");
  assert.deepEqual(scriptCommand("x.cmd", ["a"], "win32"), { file: "cmd.exe", args: ["/c", "x.cmd", "a"] });
  assert.deepEqual(scriptCommand("x.sh", ["a"], "linux"), { file: "bash", args: ["x.sh", "a"] });
  assert.deepEqual(scriptCommand("x.sh", ["a"], "win32", () => true, () => "C:\\Program Files\\Git\\bin\\bash.exe"), { file: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["x.sh", "a"] }, "Git's bash, not the WSL launcher that bash on the PATH can be");
  assert.equal(scriptCommand("x.sh", [], "win32", () => true, () => undefined).file, "bash", "no Git for Windows: the person's own bash");
  assert.equal(scriptCommand("x.sh", [], "linux", () => true, () => "C:\\Git\\bin\\bash.exe").file, "bash", "only on Windows");
  assert.deepEqual(scriptCommand("x.mjs", ["a"], "linux"), { file: process.execPath, args: ["x.mjs", "a"] });
  assert.deepEqual(scriptCommand("tool", ["a"], "linux"), { file: "tool", args: ["a"] });
  assert.equal(foundWorktree("/nonexistent", "", "b"), undefined);
});
