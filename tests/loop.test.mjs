import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contextRows, delegations, markersIn, rowsBeforeDelegation } from "../scripts/loop/lib/claude.mjs";
import { exitCriteria, roundReport } from "../scripts/loop/lib/report.mjs";
import { TOY_TASKS, createToy } from "../scripts/loop/lib/fixture.mjs";
import { SCENARIOS, loadConfig, parseArgs, scenarioTargets } from "../scripts/loop/loop.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loop = path.join(repo, "scripts/loop/loop.mjs");
const tmp = (name) => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `cantus-loop-${name}-`));

test("loop: arguments and config, unknown scenarios refused", () => {
  assert.deepEqual(parseArgs(["--rounds", "2", "--only", "plugin,task-tutto", "--fix"]), { rounds: 2, only: ["plugin", "task-tutto"], fix: true });
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  const dir = tmp("config");
  const file = path.join(dir, "loop.config.json");
  fs.writeFileSync(file, JSON.stringify({ rounds: 5, targets: [{ name: "toy" }, { name: "legacy", path: "/x" }], fix: { budgetUsd: 1 } }));
  const config = loadConfig({ config: file, targets: ["legacy"], fix: true });
  assert.equal(config.rounds, 5);
  assert.deepEqual(config.targets, [{ name: "legacy", path: "/x" }]);
  assert.deepEqual([config.fix.enabled, config.fix.budgetUsd, config.fix.timeoutMin], [true, 1, 45], "fix settings merge with the defaults");
  assert.throws(() => loadConfig({ config: file, only: ["nope"] }), /Unknown scenario\(s\): nope/);
});

test("loop: the plugin scenario runs on the toy and on the targets that name an API change", () => {
  const plugin = SCENARIOS.find((scenario) => scenario.id === "plugin");
  const h3 = { name: "h3", repo: "https://example.com/h3.git", plugin: { file: "src/error.ts", block: "h3", change: "change createError" } };
  const config = { targets: [{ name: "toy" }, { name: "legacy", path: "/x" }, h3] };
  assert.deepEqual(scenarioTargets(plugin, config).map((target) => target.name), ["toy", "h3"]);
  assert.ok(TOY_TASKS.plugin.change.includes(TOY_TASKS.plugin.file), "the toy names its own change");
  const tutto = SCENARIOS.find((scenario) => scenario.id === "task-tutto");
  assert.deepEqual(scenarioTargets(tutto, config).map((target) => target.name), ["toy", "legacy", "h3"], "other scenarios are unchanged");
});

test("loop: markers count only where they reached the model, before the delegation for the main agent", () => {
  const rows = [
    { type: "user", message: { content: "hello" }, attachment: "nested memory MK-AAAAAAAA" },
    { type: "assistant", message: { content: [{ type: "text", text: "I see MK-BBBBBBBB" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input: { subagent_type: "block-src-billing", prompt: "Read it" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "the subagent says MK-CCCCCCCC" }] } },
  ];
  const all = ["MK-AAAAAAAA", "MK-BBBBBBBB", "MK-CCCCCCCC"];
  assert.deepEqual(markersIn(contextRows(rowsBeforeDelegation(rows)), all), ["MK-AAAAAAAA"], "its own words and the subagent's answer do not count");
  assert.deepEqual(delegations(rows), [{ agent: "block-src-billing", prompt: "Read it", parent: null }]);
});

test("loop: the probe hook logs the agent behind each tool call and prints nothing", () => {
  const out = path.join(tmp("probe"), "probe.jsonl");
  const input = { hook_event_name: "PreToolUse", agent_id: "a1", agent_type: "block-src-pricing", tool_name: "Edit", tool_input: { file_path: "/p/src/pricing/index.js" }, session_id: "s" };
  const run = spawnSync(process.execPath, [path.join(repo, "scripts/loop/lib/probe-hook.mjs")], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, LOOP_PROBE_LOG: out } });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
  const row = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual([row.event, row.agentType, row.tool, row.file], ["PreToolUse", "block-src-pricing", "Edit", "/p/src/pricing/index.js"]);
});

test("loop: exit criteria per project, and the round report lists failures and observations apart", () => {
  const results = [
    { scenario: "task-mappa", target: "toy", outDir: "/r/a", seconds: 3, checks: [{ kind: "assert", name: "Merge", ok: false, detail: "conflict" }] },
    { scenario: "task-autonomo", target: "toy", outDir: "/r/b", seconds: 2, checks: [{ kind: "assert", name: "merge: nessun crash di Cantus", ok: true }] },
    { scenario: "plugin", target: "toy", outDir: "/r/c", seconds: 1, checks: [{ kind: "observe", name: "hook dentro lo specialista", ok: false, detail: "no" }] },
  ];
  const criteria = exitCriteria(results, ["toy", "legacy"]);
  assert.deepEqual(criteria.map((row) => `${row.criterion} | ${row.target} | ${row.ok}`), [
    "Task su un blocco fino al merge, senza interventi fuori dalla mappa | toy | true",
    "Task su tutto il progetto fino al merge | toy | undefined",
    "Task su un blocco fino al merge, senza interventi fuori dalla mappa | legacy | undefined",
    "Task su tutto il progetto fino al merge | legacy | undefined",
    "Gli hook avvisano davvero di un breaking change | toy | true",
    "Nessun crash aperto | tutti | true",
  ]);
  const report = roundReport({ round: 1, results, criteria, spent: 1.5, artifactsDir: "/r" });
  assert.match(report, /- \*\*task-mappa \/ toy\*\* — Merge\n {2}`conflict`/);
  assert.match(report, /## Osservazioni \(domande aperte, non giudicate\)\n\n- ✗ plugin \/ toy: hook dentro lo specialista — no/);
  assert.match(report, /\| Task su tutto il progetto fino al merge \| legacy \| non provato \|/);
});

/** A runner standing in for Claude Code: plans, edits in scope, asks for a file outside, edits again, runs the tests. */
function scriptedRunner() {
  const file = path.join(tmp("runner"), "runner.mjs");
  fs.writeFileSync(file, `import fs from "node:fs";
import path from "node:path";
export default (request) => {
  let mode = request.permissionMode;
  async function* run() {
    if (/detailed explanation/.test(request.prompt)) {
      while (!request.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 100));
      yield { type: "result", ok: false, text: "Stopped" };
      return;
    }
    if (mode === "plan") {
      yield { type: "text", text: "Plan: add formatTotal to pricing with its test, and leave the users README to its block." };
      await request.canUseTool("ExitPlanMode", { plan: "1. Add formatTotal to src/pricing with its test. 2. Leave the users README to its block." }, request.abort.signal);
    }
    const pricing = path.join(request.cwd, "src/pricing/index.js");
    const readme = path.join(request.cwd, "src/users/README.md");
    for (const text of ["export const formatTotal = (cents, currency) => currency + ' ' + (cents / 100).toFixed(2);", null, "// formatTotal done"]) {
      if (text === null) {
        if ((await request.canUseTool("Write", { file_path: readme }, request.abort.signal)).allow) fs.writeFileSync(readme, "pricing has formatTotal\\n");
      } else if ((await request.canUseTool("Edit", { file_path: pricing }, request.abort.signal)).allow) {
        fs.appendFileSync(pricing, "\\n" + text + "\\n");
        yield { type: "tool", tool: "Edit", input: { file_path: pricing } };
      }
    }
    await request.canUseTool("Bash", { command: "npm test" }, request.abort.signal);
    await request.canUseTool("Bash", { command: "git push" }, request.abort.signal);
    yield { type: "result", ok: true, text: "Added formatTotal; users README left to its block.", costUsd: 0.01 };
  }
  const iterator = run();
  return { [Symbol.asyncIterator]: () => iterator, async setPermissionMode(next) { mode = next; } };
};
`);
  return file;
}

function fakeClaude() {
  const file = path.join(tmp("claude"), "claude");
  fs.writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("0.0.0 (fake)");
else if (args[0] === "auth") console.log(JSON.stringify({ loggedIn: true, authMethod: "fake" }));
else process.exit(3);
`, { mode: 0o755 });
  return file;
}

test("loop: a round end to end with a scripted agent, on the toy project", { skip: process.platform === "win32" && "the loop's shell steps run in a Linux container" }, () => {
  const work = tmp("work");
  const config = path.join(work, "loop.config.json");
  fs.writeFileSync(config, JSON.stringify({
    work,
    claudeBin: fakeClaude(),
    runner: scriptedRunner(),
    rounds: 1,
    longWaitMin: 0,
    taskTimeoutMin: 2,
    scenarios: ["task-mappa", "task-autonomo"],
    cantus: { source: repo, clone: false },
  }));
  const run = spawnSync(process.execPath, [loop, "--config", config], { encoding: "utf8", timeout: 300_000 });
  const [runDir] = fs.readdirSync(work).filter((name) => name.startsWith("run-")).map((name) => path.join(work, name));
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
  const results = summary.rounds[0].results;
  const failed = results.flatMap((result) => [result.error, ...result.checks.filter((check) => check.kind === "assert" && !check.ok).map((check) => `${result.scenario}: ${check.name} — ${check.detail}`)]).filter(Boolean);
  assert.deepEqual(failed, [], run.stderr);
  assert.equal(run.status, 0, run.stderr);
  const map = results.find((result) => result.scenario === "task-mappa").checks;
  const names = map.map((check) => check.name);
  for (const expected of ["piano chiesto in approvazione", "dopo l'approvazione del piano chiede prima di modificare", "Merge into your branch", "Stop su un altro task", "merge: verifica dopo il merge (npm test)"]) assert.ok(names.includes(expected), `${expected} in ${names.join(", ")}`);
  assert.ok(map.find((check) => check.name === "modifica fuori perimetro chiesta e negata").ok);
  const autonomous = results.find((result) => result.scenario === "task-autonomo").checks;
  assert.ok(autonomous.find((check) => check.name === "comandi di shell consentiti: solo la verifica").ok);
  assert.ok(autonomous.find((check) => check.name === "modifica fuori perimetro rifiutata e citata").ok);
  const report = fs.readFileSync(path.join(runDir, "round-1.md"), "utf8");
  assert.match(report, /\| Task su un blocco fino al merge, senza interventi fuori dalla mappa \| toy \| ✓ \|/);
  assert.match(fs.readFileSync(path.join(runDir, "SUMMARY.md"), "utf8"), /Fine: fatti tutti i 1 giri\./);
});

test("loop: in worktree mode the work stays in the user's repository, on a branch, and nothing else there changes; Cantus works in a folder of it", { skip: process.platform === "win32" && "the loop's shell steps run in a Linux container" }, () => {
  const work = tmp("work");
  // The user's repository holds more than the project: the toy shop is its "app" folder.
  const shop = path.join(tmp("user"), "repo");
  fs.rmSync(path.join(createToy(path.join(shop, "app")), ".git"), { recursive: true, force: true });
  fs.writeFileSync(path.join(shop, "README.md"), "the rest of the user's repository\n");
  const gitIn = (...args) => spawnSync("git", args, { cwd: shop, encoding: "utf8" }).stdout.trim();
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "me@example.com"], ["config", "user.name", "Me"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) spawnSync("git", args, { cwd: shop });
  fs.writeFileSync(path.join(shop, "notes.txt"), "uncommitted work of the user\n");
  const before = { head: gitIn("rev-parse", "HEAD"), branch: gitIn("branch", "--show-current"), config: fs.readFileSync(path.join(shop, ".git/config"), "utf8"), status: gitIn("status", "--porcelain") };
  const exclude = () => (fs.existsSync(path.join(shop, ".git/info/exclude")) ? fs.readFileSync(path.join(shop, ".git/info/exclude"), "utf8") : "");
  const excludeBefore = exclude();
  const config = path.join(work, "loop.config.json");
  fs.writeFileSync(config, JSON.stringify({
    work,
    claudeBin: fakeClaude(),
    runner: scriptedRunner(),
    rounds: 1,
    longWaitMin: 0,
    taskTimeoutMin: 2,
    scenarios: ["task-autonomo"],
    targets: [{ name: "shop", path: shop, subdir: "app", worktree: true, ...TOY_TASKS, block: "app-pricing", addBlocks: [{ id: "app-pricing", name: "Pricing (by hand)", include: ["src/pricing"], description: "Prices, discounts and totals." }] }],
    cantus: { source: repo, clone: false },
  }));
  const run = spawnSync(process.execPath, [loop, "--config", config], { encoding: "utf8", timeout: 300_000 });
  const [runDir] = fs.readdirSync(work).filter((name) => name.startsWith("run-")).map((name) => path.join(work, name));
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
  const [result] = summary.rounds[0].results;
  const failed = [result.error, ...result.checks.filter((check) => check.kind === "assert" && !check.ok).map((check) => `${check.name} — ${check.detail}`)].filter(Boolean);
  assert.deepEqual(failed, [], run.stderr);
  assert.deepEqual({ head: gitIn("rev-parse", "HEAD"), branch: gitIn("branch", "--show-current"), config: fs.readFileSync(path.join(shop, ".git/config"), "utf8"), status: gitIn("status", "--porcelain") }, before, "the user's checkout, config and uncommitted work are untouched");
  assert.equal(exclude(), excludeBefore, "no ignore rules added to the user's repository");
  const [branch] = gitIn("branch", "--list", "cantus-loop/*").split("\n").map((line) => line.replace(/^[*+ ]+/, "").trim());
  assert.match(branch, /^cantus-loop\/\d{8}-\d{6}\/r1-task-autonomo$/);
  assert.match(gitIn("show", `${branch}:app/src/pricing/index.js`), /formatTotal/, "the merged task is on the loop's branch, in the project's folder");
  // The task above worked on "app-pricing", a block that only the map has: Cantus's task got the map.
  assert.equal(gitIn("ls-tree", "-r", "--name-only", branch, "--", "app/.cantus"), "", "neither the map nor Cantus's working files are committed");
  assert.deepEqual(gitIn("diff", "--name-only", `${before.head}...${branch}`, "--", "app/src", ":(exclude,glob)**/AGENTS.md").split("\n"), ["app/src/pricing/index.js"], "besides the block notes, the branch holds the agent's work");
  assert.equal(gitIn("log", "-1", "--format=%an", branch), "Cantus loop");
  assert.equal(gitIn("worktree", "list").split("\n").length, 1, "the loop's worktree folder is removed, the branch stays");
  assert.equal(gitIn("branch", "--list", "cantus/task-*"), "", "no task branches left");
});

test("loop: a task start whose connection drops is not lost and not started twice", async () => {
  const { createServer } = await import("node:http");
  const { client } = await import("../scripts/loop/lib/serve.mjs");
  for (const createsBeforeDrop of [false, true]) {
    const tasks = [];
    let posts = 0;
    let listDrops = 1; // the server is busy: the first read of the list is dropped too
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.method === "GET") return listDrops-- > 0 ? req.socket.destroy() : res.end(JSON.stringify(tasks));
        posts++;
        const task = { id: `t${tasks.length + 1}`, prompt: JSON.parse(body).prompt, status: "running" };
        if (posts === 1) {
          if (createsBeforeDrop) tasks.push(task);
          return req.socket.destroy();
        }
        tasks.push(task);
        res.end(JSON.stringify(task));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const api = client({ url: `http://127.0.0.1:${server.address().port}/`, token: "x" }, { exitCode: null });
      const started = await api.start({ prompt: "do it" });
      assert.equal(started.prompt, "do it");
      assert.equal(tasks.length, 1, "one task, whether the dropped request had started it or not");
      assert.equal(posts, createsBeforeDrop ? 1 : 2);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("loop: a target with refine runs cantus refine once and then reuses the refined map", async () => {
  const { mapProject } = await import("../scripts/loop/lib/fixture.mjs");
  const dir = tmp("refine");
  const runner = path.join(dir, "runner.mjs");
  const answer = "```json\n" + JSON.stringify({ blocks: [{ id: "src-billing", description: "Charges invoices." }] }) + "\n```";
  fs.writeFileSync(runner, `export default () => { async function* run() { yield { type: "result", ok: true, text: ${JSON.stringify(answer)} }; } const it = run(); return { [Symbol.asyncIterator]: () => it, async setPermissionMode() {} }; };\n`);
  const ctx = { cantusCli: path.join(repo, "dist/cli.js"), env: process.env, runner, spent: 0, spend(usd) { this.spent += usd; } };
  const description = (model) => model.blocks.find((block) => block.id === "src-billing").description;

  const first = path.join(dir, "first");
  createToy(first);
  const refined = mapProject(ctx, first, { refine: {} });
  assert.equal(description(refined.model), "Charges invoices.");
  assert.equal(description(refined.refined.model), "Charges invoices.");
  assert.ok(refined.steps.some((step) => step.command.startsWith("cantus refine --json")));

  // Another scenario: the same refined map, and no new session (this runner no longer exists).
  fs.rmSync(runner);
  const second = path.join(dir, "second");
  createToy(second);
  const reused = mapProject(ctx, second, { refine: { cached: refined.refined.model } });
  assert.equal(description(reused.model), "Charges invoices.");
  assert.ok(!reused.steps.some((step) => step.command.startsWith("cantus refine")));

  const plain = path.join(dir, "plain");
  createToy(plain);
  assert.notEqual(description(mapProject(ctx, plain, {}).model), "Charges invoices.", "without refine the map stays the analysis's");
});

test("loop: scenarios share one refined map per target and run, even with their own copies of the context", async () => {
  const { prepareTarget } = await import("../scripts/loop/lib/targets.mjs");
  const dir = tmp("refine-shared");
  const runner = path.join(dir, "runner.mjs");
  const answer = "```json\n" + JSON.stringify({ blocks: [{ id: "src-billing", description: "Charges invoices." }] }) + "\n```";
  fs.writeFileSync(runner, `export default () => { async function* run() { yield { type: "result", ok: true, text: ${JSON.stringify(answer)} }; } const it = run(); return { [Symbol.asyncIterator]: () => it, async setPermissionMode() {} }; };\n`);
  const ctx = { runDir: dir, cantusCli: path.join(repo, "dist/cli.js"), env: process.env, runner };
  const target = { name: "toy", refine: true };
  const first = prepareTarget({ ...ctx }, target, path.join(dir, "one"));
  assert.equal(first.model.blocks.find((block) => block.id === "src-billing").description, "Charges invoices.");
  fs.rmSync(runner); // a second session would fail: the scenario below must reuse the first one's map
  const second = prepareTarget({ ...ctx }, target, path.join(dir, "two"));
  assert.equal(second.model.blocks.find((block) => block.id === "src-billing").description, "Charges invoices.");
});

test("loop: tool use is summarized from the calls: Cantus tools by name, orientation before the first edit, review after the last", async () => {
  const { cantusToolName, describeToolUse, summarizeToolUse } = await import("../scripts/loop/lib/usage.mjs");
  assert.equal(cantusToolName("mcp__plugin_cantus_cantus__find_api"), "find_api");
  assert.equal(cantusToolName("mcp__cantus__map"), "map");
  assert.equal(cantusToolName("mcp__other__map"), undefined);
  assert.equal(cantusToolName(undefined), undefined);

  const careful = summarizeToolUse([
    { tool: "mcp__plugin_cantus_cantus__map" },
    { tool: "mcp__plugin_cantus_cantus__callers" },
    { tool: "Read" },
    { tool: "Edit" },
    { tool: "Edit" },
    { tool: "mcp__plugin_cantus_cantus__review_changes", parent: "sub1" },
  ]);
  assert.deepEqual([careful.calls, careful.edits, careful.cantusCalls, careful.bySubagents], [6, 2, 3, 1]);
  assert.deepEqual(careful.beforeFirstEdit, ["map", "callers"]);
  assert.deepEqual([careful.oriented, careful.checkedCallers, careful.closedTheLoop], [true, true, ["review_changes"]]);
  assert.match(describeToolUse(careful), /3 chiamate Cantus su 6.*callers\/impact prima: sì.*review_changes/);

  const blind = summarizeToolUse([{ tool: "Read" }, { tool: "Edit" }, { tool: "mcp__cantus__check" }]);
  assert.deepEqual([blind.oriented, blind.checkedCallers, blind.beforeFirstEdit], [false, false, []]);
  assert.deepEqual(blind.closedTheLoop, ["check"]);

  const none = summarizeToolUse([{ tool: "Read" }, { tool: "Edit" }]);
  assert.equal(none.cantusCalls, 0);
  assert.match(describeToolUse(none), /nessuno strumento Cantus su 2 chiamate \(1 modifiche\)/);

  const noEdit = summarizeToolUse([{ tool: "mcp__cantus__map" }]);
  assert.equal(noEdit.oriented, false, "orientation only counts before an edit");
  assert.match(describeToolUse(noEdit), /nessuna modifica/);
});
