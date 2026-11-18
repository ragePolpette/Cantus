import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProjectState, TaskManager, claudeCliArguments, needsAction, parseReview, planVerification, prepareVerification, verifyDecision } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function shop({ model = shopModel() } = {}) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/runs/\n");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return { root, run };
}

function fakeRunner(script) {
  const runs = [];
  const runner = (request) => {
    const session = { request, [Symbol.asyncIterator]: () => script(request, session) };
    runs.push(session);
    return session;
  };
  return { runner, runs };
}

const REPORT = (extra = {}) => "Looked at it.\n```json\n" + JSON.stringify({ verdict: "issues", summary: "One real problem.", checked: ["read cart.ts"], findings: [{ severity: "major", title: "Discount is never applied", detail: "cart.ts exports it but checkout ignores it", file: "src/checkout/cart.ts", line: 3, evidence: "grep found no caller" }], ...extra }) + "\n```";

test("what to verify: uncommitted work against the last commit, a branch against main, nothing otherwise", () => {
  const { root, run } = shop();
  assert.throws(() => planVerification(new ProjectState(root)), /Nothing to verify: no uncommitted changes, and this branch has no commits beyond the default one/);

  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  fs.writeFileSync(path.join(root, "src/pricing/vat.ts"), "export const vat = 0.22;\n");
  const plan = planVerification(new ProjectState(root), { about: "Add a discount", tests: false });
  assert.deepEqual(plan.files, ["src/checkout/cart.ts", "src/pricing/vat.ts"]);
  assert.deepEqual(plan.blocks.sort(), ["src-checkout", "src-pricing"]);
  assert.equal(plan.base.label, "the last commit (uncommitted work)");
  assert.equal(plan.testCommand, undefined);

  run("add", "-A");
  run("commit", "-q", "-m", "discount");
  assert.throws(() => planVerification(new ProjectState(root)), /Nothing to verify/, "committed on main itself: the clean tree has nothing beyond the default branch");
  const first = run("rev-parse", "HEAD~1").trim();
  assert.deepEqual(planVerification(new ProjectState(root), { base: "HEAD~1" }).files, ["src/checkout/cart.ts", "src/pricing/vat.ts"]);
  assert.equal(planVerification(new ProjectState(root), { base: "HEAD~1" }).base.commit, first);

  run("checkout", "-q", "-b", "feature");
  fs.appendFileSync(path.join(root, "src/orders/index.ts"), "\nexport const note = 1;\n");
  run("commit", "-q", "-am", "note");
  const branch = planVerification(new ProjectState(root));
  assert.deepEqual(branch.files, ["src/orders/index.ts"], "a clean branch with its own commit compares with where it left main");
  assert.match(branch.base.label, /^main \(/);

  assert.throws(() => planVerification(new ProjectState(root), { base: "nope" }), /"nope" is not a commit/);
});

test("not a git repository: nothing to compare with", () => {
  const root = copyFixture("shop");
  assert.throws(() => planVerification(new ProjectState(root)), /needs a git repository/);
});

test("the test command comes from the flag, else the map; false skips it", () => {
  const { root } = shop({ model: { ...shopModel(), agent: { verifyCommand: "npm test" } } });
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const state = new ProjectState(root);
  assert.equal(planVerification(state).testCommand, "npm test");
  assert.equal(planVerification(state, { tests: "pnpm vitest" }).testCommand, "pnpm vitest");
  assert.equal(planVerification(state, { tests: false }).testCommand, undefined);
});

test("the verifier is given the request, the diff, new files, the tests' result and the computed review", async () => {
  const { root } = shop({ model: { ...shopModel(), agent: { verifyCommand: `node -e "console.log('3 passing')"` } } });
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport function vatOf(amount: number) { return amount * 0.22; }\n");
  fs.writeFileSync(path.join(root, "src/pricing/vat.ts"), "export const VAT = 0.22;\n");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const state = new ProjectState(root);
  const plan = planVerification(state, { about: "Add VAT to pricing", claims: "Done, tests pass." });
  const logs = [];
  const prepared = await prepareVerification(state, plan, { log: (line) => logs.push(line) });
  assert.equal(prepared.tests.exitCode, 0);
  assert.match(prepared.tests.output, /3 passing/);
  const prompt = prepared.prompt;
  assert.match(prompt, /## What the changes were meant to do\n\nAdd VAT to pricing/);
  assert.match(prompt, /What the author says it did[\s\S]*claims to check, not facts[\s\S]*Done, tests pass\./);
  assert.match(prompt, /\+export function vatOf\(amount: number\)/, "the diff of a tracked file");
  assert.match(prompt, /diff --git a\/src\/pricing\/vat\.ts[\s\S]*new file \(not tracked by git yet\)[\s\S]*\+export const VAT = 0\.22;/, "an untracked file as a new file");
  assert.match(prompt, /pnpm-lock\.yaml \(lockfile or generated: diff left out\)/);
  assert.doesNotMatch(prompt, /lockfileVersion/);
  assert.match(prompt, /passed in [\d.]+s[\s\S]*3 passing/);
  assert.match(prompt, /#### Changes since the last commit \(uncommitted work\)/, "review_changes, labelled with what it compares with, nested under its section");
  assert.match(prompt, /## Map context for the blocks the changes touch[\s\S]*src-pricing/);
  assert.match(prompt, /"verdict": "ok \| issues \| incomplete"/);
  assert.deepEqual(prepared.diffOmitted, ["pnpm-lock.yaml (lockfile or generated: diff left out)"]);
  assert.ok(logs.some((line) => /Running the tests/.test(line)));
  assert.doesNotMatch(prompt, /\.cantus\/model\.json/, "Cantus's own files are not work to review");
});

test("without a request or a test command the prompt says so", async () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const state = new ProjectState(root);
  const { prompt } = await prepareVerification(state, planVerification(state));
  assert.match(prompt, /No request was given\. Judge the changes on their own/);
  assert.match(prompt, /No test command is configured, so nothing was run/);
});

test("a failing test run is reported to the verifier, not hidden", async () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const state = new ProjectState(root);
  const plan = planVerification(state, { tests: `node -e "console.error('boom'); process.exit(3)"` });
  const { prompt, tests } = await prepareVerification(state, plan);
  assert.equal(tests.exitCode, 3);
  assert.match(prompt, /failed \(exit 3\)[\s\S]*boom/);
});

test("a verification task: read-only rules, report parsed, cost kept, nobody asked", async () => {
  const { root } = shop({ model: { ...shopModel(), agent: { verifyCommand: "npm test", models: { verify: "claude-verify-model" } } } });
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  const decisions = {};
  const { runner, runs } = fakeRunner(async function* (request) {
    const ask = async (tool, input) => (decisions[`${tool}:${input.command ?? input.file_path ?? ""}`] = (await request.canUseTool(tool, input, request.abort.signal)).allow);
    await ask("Read", { file_path: path.join(request.cwd, "src/checkout/cart.ts") });
    await ask("Edit", { file_path: path.join(request.cwd, "src/checkout/cart.ts") });
    await ask("Bash", { command: "git diff HEAD -- src/checkout" });
    await ask("Bash", { command: "git diff --output=/tmp/x" });
    await ask("Bash", { command: "npm test -- --silent" });
    await ask("Bash", { command: "npm test && rm -rf ." });
    await ask("Bash", { command: "rm -rf src" });
    await ask("mcp__cantus__callers", {});
    await ask("mcp__plugin_cantus_cantus__add_block", {});
    await ask("mcp__jenkins__run_job", {});
    await ask("Task", {});
    await ask("WebFetch", { url: "https://example.com" });
    yield { type: "tool", tool: "Read", input: { file_path: path.join(request.cwd, "src/checkout/cart.ts") } };
    yield { type: "result", ok: true, text: REPORT(), costUsd: 0.21 };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ prompt: "", verify: { about: "Add a discount", tests: false } });
  const done = await tasks.wait(task.id);

  assert.equal(done.status, "done");
  assert.equal(done.costUsd, 0.21);
  assert.equal(done.model, "claude-verify-model", "agent.models.verify");
  assert.equal(done.approvals.length, 0);
  const request = runs[0].request;
  assert.deepEqual(request.disallowedTools, ["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  assert.equal(request.maxBudgetUsd, 1.5);
  assert.equal(request.maxTurns, 40);
  assert.equal(request.permissionMode, "default");
  assert.equal(request.cwd, root, "in the project, not a copy: a worktree would not see uncommitted work");
  assert.match(request.prompt, /Add a discount/);
  assert.deepEqual(decisions, {
    [`Read:${path.join(root, "src/checkout/cart.ts")}`]: true,
    [`Edit:${path.join(root, "src/checkout/cart.ts")}`]: false,
    "Bash:git diff HEAD -- src/checkout": true,
    "Bash:git diff --output=/tmp/x": false,
    "Bash:npm test -- --silent": false, // tests: false in this run, so no test command is allowed
    "Bash:npm test && rm -rf .": false,
    "Bash:rm -rf src": false,
    "mcp__cantus__callers:": true,
    "mcp__plugin_cantus_cantus__add_block:": false,
    "mcp__jenkins__run_job:": false,
    "Task:": false,
    "WebFetch:": false,
  });
  const review = done.verification.review;
  assert.equal(review.verdict, "issues");
  assert.deepEqual(review.findings.map((finding) => [finding.severity, finding.file, finding.line]), [["major", "src/checkout/cart.ts", 3]]);
  assert.equal(needsAction(review), true);
  assert.equal(done.verification.modified, undefined);
  const record = JSON.parse(fs.readFileSync(path.join(root, ".cantus/runs", `${done.id}.json`), "utf8"));
  assert.equal(record.verification.review.findings[0].title, "Discount is never applied");
});

test("the test command stays allowed to the verifier when one is configured, without extra arguments", async () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  assert.deepEqual(verifyDecision("Bash", { command: "pnpm test" }, "pnpm test"), { allow: true });
  assert.equal(verifyDecision("Bash", { command: "pnpm test cart" }, "pnpm test").allow, false);
  assert.equal(verifyDecision("Bash", { command: "pnpm testing" }, "pnpm test").allow, false);
  assert.equal(verifyDecision("Bash", { command: "pnpm test $(whoami)" }, "pnpm test").allow, false);
});

test("a verifier that changes files is caught; so is one that cannot finish", async () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  const { runner } = fakeRunner(async function* (request) {
    fs.appendFileSync(path.join(request.cwd, "src/checkout/cart.ts"), "\n// sneaky\n");
    fs.writeFileSync(path.join(request.cwd, "src/db/new.ts"), "export {};\n");
    yield { type: "result", ok: true, text: REPORT({ verdict: "ok", findings: [] }), costUsd: 0.05 };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const done = await tasks.wait(tasks.start({ prompt: "", verify: { tests: false } }).id);
  assert.deepEqual(done.verification.modified, ["src/checkout/cart.ts", "src/db/new.ts"]);
  assert.ok(done.events.some((event) => event.kind === "error" && /Files differ after the verification/.test(event.text)));

  const { runner: broke } = fakeRunner(async function* () {
    yield { type: "result", ok: false, text: "Stopped: error_max_budget_usd", costUsd: 1.5 };
  });
  const tasks2 = new TaskManager(new ProjectState(root), broke);
  const failed = await tasks2.wait(tasks2.start({ prompt: "", verify: { tests: false } }).id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.verification.review, undefined);
  assert.equal(failed.result, "Stopped: error_max_budget_usd");
});

test("stopping a verification while the tests run ends it without starting the agent", async () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const { runner, runs } = fakeRunner(async function* () {
    yield { type: "result", ok: true, text: REPORT({ findings: [], verdict: "ok" }) };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const task = tasks.start({ prompt: "", verify: { tests: `node -e "setTimeout(() => {}, 30000)"` } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  tasks.stop(task.id);
  const done = await tasks.wait(task.id);
  assert.equal(done.status, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runs.length, 0, "the agent never started");
  assert.equal(tasks.get(task.id).status, "stopped");
});

test("a bad model name is refused before anything runs", () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const tasks = new TaskManager(new ProjectState(root), () => assert.fail("must not start"));
  assert.throws(() => tasks.start({ prompt: "", model: "no spaces allowed", verify: {} }), /is not a model name/);
  assert.equal(tasks.list().length, 0);
});

test("the report: JSON block read and checked, findings sorted, contradictions and bad files corrected", () => {
  const ok = parseReview(REPORT({ verdict: "ok" }), (file) => file === "src/checkout/cart.ts");
  assert.equal(ok.verdict, "issues", "an ok verdict with a major finding does not stand");

  const messy = parseReview(
    "text first\n```json\n" +
      JSON.stringify({
        verdict: "issues",
        summary: "S",
        checked: ["a", 5, "b"],
        findings: [
          { severity: "note", title: "q" },
          { severity: "blocker", title: "Broken caller", file: "src/web/checkout-page.ts", line: 9.5, detail: "d" },
          { severity: "bogus", title: "Odd severity", file: "../../etc/passwd", detail: "x" },
          { severity: "minor", file: "src/nowhere.ts", detail: "No title but a detail\nsecond line" },
          { severity: "minor" },
          "junk",
        ],
      }) +
      "\n```\ntrailing prose",
    (file) => file === "src/web/checkout-page.ts",
  );
  assert.deepEqual(messy.checked, ["a", "b"]);
  assert.deepEqual(messy.findings.map((finding) => finding.severity), ["blocker", "minor", "note", "note"]);
  assert.equal(messy.findings[0].line, undefined, "a line that is not a whole number is dropped");
  assert.equal(messy.findings[0].file, "src/web/checkout-page.ts");
  const odd = messy.findings.find((finding) => finding.title === "Odd severity");
  assert.equal(odd.severity, "note");
  assert.equal(odd.file, undefined);
  assert.match(odd.detail, /not a file of the project/);
  assert.equal(messy.findings.find((finding) => finding.title === "No title but a detail").severity, "minor");

  const none = parseReview('```json\n{"verdict":"issues","findings":[]}\n```');
  assert.equal(none.verdict, "incomplete");
  assert.match(none.warnings[0], /listed none/);

  const bare = parseReview('Done. {"verdict":"ok","summary":"Fine","checked":[],"findings":[]}');
  assert.equal(bare.verdict, "ok");
  assert.equal(bare.summary, "Fine");
  assert.equal(needsAction(bare), false);
});

test("a report that is not JSON is kept as text and the verdict is incomplete", () => {
  const review = parseReview("I think it is fine but I did not use the JSON format.");
  assert.equal(review.verdict, "incomplete");
  assert.deepEqual(review.findings, []);
  assert.match(review.unstructured, /did not use the JSON format/);
  assert.match(review.warnings[0], /not in the JSON form/);
});

test("the claude -p runner turns the editing tools off with --disallowedTools", () => {
  const args = claudeCliArguments({ permissionMode: "default", disallowedTools: ["Edit", "Write"] }, "/tmp/mcp.json");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "Edit,Write");
  assert.ok(!claudeCliArguments({ permissionMode: "default" }, "/tmp/mcp.json").includes("--disallowedTools"));
});

test("a task's session carries CANTUS_TASK, so the plugin's hooks do not give it the open session's requests", async () => {
  const { editHooks } = await import("../dist/run/sdk-runner.js");
  assert.equal(editHooks(() => {}, "ab12").env.CANTUS_TASK, "ab12");
  assert.equal(editHooks(() => {}).env.CANTUS_TASK, process.env.CANTUS_TASK);
});

function runnerModule(body) {
  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-runner-")), "runner.mjs");
  fs.writeFileSync(file, `import fs from "node:fs";\nimport path from "node:path";\nexport default (request) => {\n  async function* run() {\n${body}\n  }\n  const iterator = run();\n  return { [Symbol.asyncIterator]: () => iterator };\n};\n`);
  return file;
}

test("CLI: cantus verify prints the report, saves the record and exits 1 on a serious finding", () => {
  const { root } = shop({ model: { ...shopModel(), agent: { models: { verify: "claude-verify-model" } } } });
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  const out = path.join(root, "..", `verify-${path.basename(root)}.json`);
  const runner = runnerModule(`
    fs.writeFileSync(process.env.REQUEST_OUT, JSON.stringify({ model: request.model, budget: request.maxBudgetUsd, prompt: request.prompt }));
    yield { type: "result", ok: true, text: ${JSON.stringify(REPORT())}, costUsd: 0.2 };`);
  const result = spawnSync(process.execPath, [cli, "verify", "--about", "Add a discount", "--no-tests", "--runner", runner, "-C", root], { encoding: "utf8", env: { ...process.env, REQUEST_OUT: out } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /# Verification of 1 changed file\(s\), compared with the last commit \(uncommitted work\)/);
  assert.match(result.stdout, /Verdict: issues — One real problem\./);
  assert.match(result.stdout, /✗ \[major\] src\/checkout\/cart\.ts:3 — Discount is never applied/);
  assert.match(result.stdout, /Evidence: grep found no caller/);
  assert.match(result.stdout, /~\$0\.20 with claude-verify-model/);
  assert.match(result.stderr, /Verification [0-9a-f]+: done · ~\$0\.20\. Record: /);
  const seen = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(seen.model, "claude-verify-model");
  assert.equal(seen.budget, 1.5);
  assert.match(seen.prompt, /Add a discount/);

  const json = spawnSync(process.execPath, [cli, "verify", "--no-tests", "--json", "--budget", "0.5", "--model", "opus", "--runner", runner, "-C", root], { encoding: "utf8", env: { ...process.env, REQUEST_OUT: out } });
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.status, "done");
  assert.equal(parsed.verification.review.findings[0].severity, "major");
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).model, "opus");
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).budget, 0.5);
});

test("CLI: exit 0 when nothing serious was found; exit 1 and a clear message when there is nothing to verify", () => {
  const { root } = shop();
  const quiet = runnerModule(`yield { type: "result", ok: true, text: ${JSON.stringify(REPORT({ verdict: "ok", findings: [{ severity: "minor", title: "Naming", detail: "meh" }] }))}, costUsd: 0.1 };`);
  const nothing = spawnSync(process.execPath, [cli, "verify", "--runner", quiet, "-C", root], { encoding: "utf8" });
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /Nothing to verify: no uncommitted changes/);

  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const fine = spawnSync(process.execPath, [cli, "verify", "--no-tests", "--runner", quiet, "-C", root], { encoding: "utf8" });
  assert.equal(fine.status, 0, fine.stderr);
  assert.match(fine.stdout, /\[minor\] — Naming/);
});

test("CLI: --dry-run prints what the verifier would get and starts nothing", () => {
  const { root } = shop({ model: { ...shopModel(), agent: { verifyCommand: "npm test" } } });
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  const result = spawnSync(process.execPath, [cli, "verify", "--dry-run", "--about", "Add a discount", "-C", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /You are an independent reviewer/);
  assert.match(result.stdout, /Add a discount/);
  assert.match(result.stdout, /Not run\. The command is `npm test`/);
  assert.match(result.stderr, /Dry run: the tests \(`npm test`\) were not run, and no agent was started\./);
  assert.equal(fs.existsSync(path.join(root, ".cantus/runs")), false);
});

test("untracked notes that Cantus generated are not work to review; other new files are, and are marked", async () => {
  const { root } = shop();
  fs.mkdirSync(path.join(root, "docs/blocks"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/blocks/src-pricing.md"), "# Pricing\n\n<!-- write the team's notes here -->\n");
  fs.mkdirSync(path.join(root, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/agents/block-src-pricing.md"), "---\nname: block-src-pricing\n---\n");
  const state = new ProjectState(root);
  assert.throws(() => planVerification(state), /Nothing to verify: no uncommitted changes/, "only generated notes: nothing to verify, and the base is not 'uncommitted work'");

  fs.writeFileSync(path.join(root, "src/pricing/vat.ts"), "export const VAT = 0.22;\n");
  const plan = planVerification(state, { tests: false });
  assert.deepEqual(plan.files, ["src/pricing/vat.ts"]);
  assert.deepEqual(plan.generated, [".claude/agents/block-src-pricing.md", "docs/blocks/src-pricing.md"]);
  const { prompt } = await prepareVerification(state, plan);
  assert.match(prompt, /`src\/pricing\/vat\.ts` — added, \+1 −0, not tracked by git yet/);
  assert.match(prompt, /Left out: 2 untracked file\(s\) that Cantus generated for the map[\s\S]*docs\/blocks\/src-pricing\.md/);
  assert.doesNotMatch(prompt, /Pricing\n\n<!-- write the team's notes here/, "their content is not in the diff");
});

test("the same note, once tracked and edited, is work", () => {
  const { root, run } = shop();
  fs.mkdirSync(path.join(root, "docs/blocks"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/blocks/src-pricing.md"), "# Pricing\n");
  run("add", "-A");
  run("commit", "-q", "-m", "notes");
  fs.appendFileSync(path.join(root, "docs/blocks/src-pricing.md"), "VAT is 22%.\n");
  const plan = planVerification(new ProjectState(root), { tests: false });
  assert.deepEqual(plan.files, ["docs/blocks/src-pricing.md"]);
  assert.deepEqual(plan.generated, []);
});

test("a project inside a bigger repository: the verifier is told where it is, and about changes outside the folder", async () => {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-sub-"));
  const root = path.join(repo, "app");
  fs.cpSync(copyFixture("shop"), root, { recursive: true });
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.mkdirSync(path.join(repo, "Db"));
  fs.writeFileSync(path.join(repo, "Db/001.sql"), "select 1;\n");
  const run = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  fs.appendFileSync(path.join(repo, "Db/001.sql"), "select 2;\n");
  const state = new ProjectState(root);
  const plan = planVerification(state, { tests: false });
  assert.deepEqual(plan.files, ["src/checkout/cart.ts"]);
  assert.deepEqual(plan.outside, ["Db/001.sql"]);
  const { prompt } = await prepareVerification(state, plan);
  assert.ok(prompt.includes(`Your working directory is the project folder, \`${root}\``));
  assert.ok(prompt.includes(`(inside the git repository \`${fs.realpathSync.native(repo)}\``) || prompt.includes(`(inside the git repository \`${repo}\``));
  assert.match(prompt, /without `cd`/);
  assert.match(prompt, /Also changed in the repository outside this folder[\s\S]*`Db\/001\.sql`/);
  assert.doesNotMatch(prompt, /select 2/, "their content is not given, only their names");
});

test("a project that is the repository's top is not said to be inside it, even reached through a link or a short Windows name", async (t) => {
  const { root } = shop();
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cantus-link-")), "project");
  try {
    fs.symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return t.skip("links cannot be made here");
  }
  try {
    // Some file systems (filters, antivirus) refuse to make a folder through a Windows junction, with or without Cantus.
    fs.mkdirSync(path.join(link, ".cantus-probe"));
    fs.rmdirSync(path.join(link, ".cantus-probe"));
  } catch {
    return t.skip("a folder cannot be made through a link here");
  }
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  const state = new ProjectState(link);
  const { prompt } = await prepareVerification(state, planVerification(state, { tests: false }));
  assert.doesNotMatch(prompt, /inside the git repository/);
});

test("test classes do not show up as API changes; neighbors are summarized, not listed", async () => {
  const { root } = shop();
  fs.writeFileSync(path.join(root, "src/checkout/cart.test.ts"), "export function cartTest() { return 1; }\n");
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport function totalOf(items: number[]) { return items.length; }\n");
  const state = new ProjectState(root);
  const { prompt } = await prepareVerification(state, planVerification(state, { tests: false }));
  const api = prompt.slice(prompt.indexOf("#### Changes since"), prompt.indexOf("## Map context"));
  assert.match(api, /totalOf/);
  assert.doesNotMatch(api.slice(api.indexOf("API changes")), /cartTest/, "a test file is not an API");
  assert.match(prompt, /Neighbor contracts[\s\S]*Signatures of what this block uses are not repeated here[\s\S]*- Orders \(`src-orders`, domain\): uses \d+ of its exports/);
  assert.doesNotMatch(prompt, /```ts[\s\S]*export declare/, "no neighbor declaration files");
});

test("a refused command says why; git check-ignore and a plain git status are fine", () => {
  const refused = verifyDecision("Bash", { command: "cd /repo && git status --short | head" }, "npm test");
  assert.equal(refused.allow, false);
  assert.match(refused.message, /one plain command at a time, without/);
  assert.equal(verifyDecision("Bash", { command: "git status --short" }).allow, true);
  assert.equal(verifyDecision("Bash", { command: "git ls-files docs/blocks" }).allow, true);
  assert.equal(verifyDecision("Bash", { command: "git check-ignore -v docs/blocks/a.md" }).allow, true);
  assert.equal(verifyDecision("Bash", { command: "git push" }).allow, false);
});

test("a verification record says what it is: mode verify", async () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const { runner } = fakeRunner(async function* () {
    yield { type: "result", ok: true, text: REPORT({ verdict: "ok", findings: [] }) };
  });
  const tasks = new TaskManager(new ProjectState(root), runner);
  const done = await tasks.wait(tasks.start({ prompt: "", verify: { tests: false } }).id);
  assert.equal(done.mode, "verify");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".cantus/runs", `${done.id}.json`), "utf8")).mode, "verify");
});

test("CLI: the final report is not printed twice on stderr", () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const report = REPORT({ verdict: "ok", findings: [], summary: "UNIQUE-SUMMARY" });
  const runner = runnerModule(`
    yield { type: "text", text: ${JSON.stringify(report)} };
    yield { type: "result", ok: true, text: ${JSON.stringify(report)}, costUsd: 0.1 };`);
  const result = spawnSync(process.execPath, [cli, "verify", "--no-tests", "--runner", runner, "-C", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split("UNIQUE-SUMMARY").length - 1, 1);
});

test("CLI: --head verifies a branch nobody has checked out, in a temporary checkout that is gone afterwards", () => {
  const { root, run } = shop();
  run("checkout", "-q", "-b", "pr-1690");
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\nexport const discount = 0.1;\n");
  run("commit", "-qam", "discount");
  run("checkout", "-q", "main");
  const out = path.join(root, "..", `head-${path.basename(root)}.json`);
  const runner = runnerModule(`
    fs.writeFileSync(process.env.REQUEST_OUT, JSON.stringify({ cwd: request.cwd, prompt: request.prompt, discount: fs.readFileSync(path.join(request.cwd, "src/checkout/cart.ts"), "utf8").includes("discount") }));
    yield { type: "result", ok: true, text: ${JSON.stringify(REPORT({ verdict: "ok", findings: [] }))}, costUsd: 0.1 };`);
  const nothing = spawnSync(process.execPath, [cli, "verify", "--runner", runner, "--no-tests", "-C", root], { encoding: "utf8", env: { ...process.env, REQUEST_OUT: out } });
  assert.match(nothing.stderr, /Nothing to verify/, "main has nothing of its own");

  const result = spawnSync(process.execPath, [cli, "verify", "--head", "pr-1690", "--runner", runner, "-C", root], { encoding: "utf8", env: { ...process.env, REQUEST_OUT: out } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--head: the temporary checkout of the branch has no installed dependencies, so the tests are not run/);
  assert.match(result.stdout, /Verification of 1 changed file\(s\), compared with main/);
  const seen = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(seen.discount, true, "the reviewer read the branch's files");
  assert.match(seen.cwd.replace(/\\/g, "/"), /\.git\/cantus-verify\//);
  assert.equal(fs.existsSync(seen.cwd), false, "the temporary checkout is removed");
  assert.equal(run("worktree", "list").trim().split("\n").length, 1);
  assert.equal(run("branch", "--show-current").trim(), "main", "the project's own checkout is untouched");
  assert.ok(fs.readdirSync(path.join(root, ".cantus/runs")).length >= 1, "the record of the run is kept in the project");

  const unknown = spawnSync(process.execPath, [cli, "verify", "--head", "no-such-branch", "--runner", runner, "-C", root], { encoding: "utf8", env: { ...process.env, REQUEST_OUT: out } });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--head "no-such-branch" is not a branch, tag or commit of this repository/);
});

test("CLI: without a test command the verification says so at the start and in the report", () => {
  const { root } = shop();
  fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), "\n// x\n");
  const runner = runnerModule(`yield { type: "result", ok: true, text: ${JSON.stringify(REPORT({ verdict: "ok", findings: [] }))}, costUsd: 0.1 };`);
  const result = spawnSync(process.execPath, [cli, "verify", "--runner", runner, "-C", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No test command: the map has no agent\.verifyCommand and --tests was not given, so the tests are NOT run/);
  assert.match(result.stdout, /Tests: not run by this verification \(no test command/);
  const quiet = spawnSync(process.execPath, [cli, "verify", "--no-tests", "--runner", runner, "-C", root], { encoding: "utf8" });
  assert.doesNotMatch(quiet.stderr, /No test command/, "--no-tests is the choice, not an omission");
});
