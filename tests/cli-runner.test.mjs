import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectState, TaskManager, autonomousPolicy, claudeCliArguments, claudeCliRunner, validateModel } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.mjs");
const cli = path.join(here, "..", "dist", "cli.js");

function shop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  return root;
}

/** Runs `fn` with the fake claude and a script of permission requests. */
function withFakeClaude(script, fn) {
  const log = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "fake-claude-")), "log.json");
  const saved = { bin: process.env.CANTUS_CLAUDE_BIN, script: process.env.FAKE_CLAUDE_SCRIPT, log: process.env.FAKE_CLAUDE_LOG };
  Object.assign(process.env, { CANTUS_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_SCRIPT: JSON.stringify(script), FAKE_CLAUDE_LOG: log });
  const restore = () => {
    for (const [key, name] of [["bin", "CANTUS_CLAUDE_BIN"], ["script", "FAKE_CLAUDE_SCRIPT"], ["log", "FAKE_CLAUDE_LOG"]]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  };
  return fn(log).finally(restore);
}

async function waitFor(check, what) {
  for (let i = 0; i < 500; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("claude -p arguments: streamed JSON, Cantus answers permission prompts, limits passed on", () => {
  const args = claudeCliArguments({ permissionMode: "plan", model: "opus", maxTurns: 12, maxBudgetUsd: 3 }, "/tmp/mcp.json");
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", "--mcp-config", "/tmp/mcp.json", "--permission-prompt-tool", "mcp__cantus_approvals__approve", "--model", "opus", "--max-turns", "12", "--max-budget-usd", "3"]);
  assert.ok(!args.some((arg) => arg.includes("\n")), "the prompt is not an argument: it goes on stdin");
});

test("a task through claude -p: permission prompts reach the task's approvals over MCP", () =>
  withFakeClaude([{ tool: "Edit", file: "src/pricing/index.ts", content: "\n// vat\n" }, { tool: "Edit", file: "src/db/client.ts", content: "\n// no\n" }], async (log) => {
    const root = shop();
    const tasks = new TaskManager(new ProjectState(root), claudeCliRunner);
    const task = tasks.start({ block: "src-pricing", prompt: "Add VAT", mode: "edit" });

    const inside = await waitFor(() => task.approvals[0], "the first approval");
    assert.deepEqual([inside.tool, inside.file, inside.outsideScope], ["Edit", "src/pricing/index.ts", undefined]);
    tasks.decide(task.id, inside.id, { allow: true });
    const outside = await waitFor(() => task.approvals.find((approval) => approval.file === "src/db/client.ts"), "the outside approval");
    assert.equal(outside.outsideScope, true);
    tasks.decide(task.id, outside.id, { allow: false, message: "Not in this task." });

    const done = await tasks.wait(task.id);
    assert.equal(done.status, "done");
    assert.equal(done.result, "Finished.");
    assert.equal(done.costUsd, 0.07);
    assert.deepEqual(done.changedFiles, ["src/pricing/index.ts"]);
    assert.match(fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8"), /\/\/ vat/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "src/db/client.ts"), "utf8"), /\/\/ no/);
    assert.match(done.events.map((event) => event.text).join("\n"), /Denied Edit: Not in this task\./, "the denial message reaches the agent");

    const call = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.equal(call.cwd, fs.realpathSync(root));
    assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "default");
    assert.match(call.prompt, /Your scope for this task is the block `src-pricing`[\s\S]*Task: Add VAT/);
    assert.ok(!fs.existsSync(call.args[call.args.indexOf("--mcp-config") + 1]), "the temporary MCP config is removed");
  }));

test("cantus task --runner claude-cli: the unattended policy answers the prompts", () =>
  withFakeClaude([{ tool: "Edit", file: "src/pricing/index.ts", content: "\n// ok\n" }, { tool: "Bash", input: { command: "git push" } }], async () => {
    const root = shop();
    const result = spawnSync(process.execPath, [cli, "task", "src-pricing", "Tweak", "--runner", "claude-cli", "-C", root], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /✓ Allowed by policy: Edit src\/pricing\/index\.ts/);
    assert.match(result.stderr, /✗ Denied by policy: Bash: git push/);
    assert.match(result.stderr, /Denied Bash: Shell commands are not allowed in this run\./);
  }));

test("a missing claude binary fails the task with the reason", async () => {
  const saved = process.env.CANTUS_CLAUDE_BIN;
  process.env.CANTUS_CLAUDE_BIN = path.join(fs.realpathSync.native(os.tmpdir()), "no-such-claude-binary");
  try {
    const tasks = new TaskManager(new ProjectState(shop()), claudeCliRunner, { policy: autonomousPolicy() });
    const done = await tasks.wait(tasks.start({ block: "src-web", prompt: "x", mode: "edit" }).id);
    assert.equal(done.status, "failed");
    assert.match(done.result, /claude exited with code -1 before finishing\.[\s\S]*ENOENT/);
  } finally {
    if (saved === undefined) delete process.env.CANTUS_CLAUDE_BIN;
    else process.env.CANTUS_CLAUDE_BIN = saved;
  }
});

test("agent.runner in the map is checked", () => {
  assert.deepEqual(validateModel({ ...shopModel(), agent: { runner: "claude-cli" } }), []);
  assert.deepEqual(validateModel({ ...shopModel(), agent: { runner: "codex" } }), []);
  assert.match(validateModel({ ...shopModel(), agent: { runner: "unknown" } }).join("\n"), /agent.runner/);
});

test("agent.model and agent.models.block in the map must be model names: they end up on a command line", () => {
  assert.deepEqual(validateModel({ ...shopModel(), agent: { model: "claude-sonnet-5-5", models: { block: "opus", verify: "sonnet" } } }), []);
  assert.deepEqual(validateModel({ ...shopModel(), agent: { models: { verify: "x; y" } } }), ['agent.models.verify "x; y" is not a model name: use an alias such as opus, sonnet or haiku, or a full model id']);
  assert.deepEqual(validateModel({ ...shopModel(), agent: { model: "claude-opus-5[1m]" } }), []);
  assert.deepEqual(validateModel({ ...shopModel(), agent: { model: "sonnet; rm -rf ~", models: { block: "a b" } } }), [
    'agent.model "sonnet; rm -rf ~" is not a model name: use an alias such as opus, sonnet or haiku, or a full model id',
    'agent.models.block "a b" is not a model name: use an alias such as opus, sonnet or haiku, or a full model id',
  ]);
});

test("stopping a claude -p task ends the process and the task", () =>
  withFakeClaude([{ tool: "Write", file: "src/web/new.ts", content: "x" }], async () => {
    const tasks = new TaskManager(new ProjectState(shop()), claudeCliRunner);
    const task = tasks.start({ block: "src-web", prompt: "New page", mode: "edit" });
    await waitFor(() => task.approvals.length === 1, "the approval");
    tasks.stop(task.id);
    const done = await tasks.wait(task.id);
    assert.equal(done.status, "stopped");
  }));

test("stream events: subagent tool calls carry their parent, tool results end them, subagent text stays out", async () => {
  const { runnerMessages } = await import("../dist/run/cli-runner.js");
  assert.deepEqual(runnerMessages({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Plan" }, { type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "block-x" } }] } }), [
    { type: "text", text: "Plan" },
    { type: "tool", tool: "Agent", input: { subagent_type: "block-x" }, id: "a1" },
  ]);
  assert.deepEqual(runnerMessages({ type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "text", text: "inside" }, { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "x" } }] } }), [
    { type: "tool", tool: "Edit", input: { file_path: "x" }, id: "e1", parent: "a1" },
  ]);
  assert.deepEqual(runnerMessages({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "ok" }] } }), [{ type: "tool-done", id: "a1" }]);
  assert.deepEqual(runnerMessages({ type: "user", message: { content: "plain text" } }), []);
  assert.deepEqual(runnerMessages({ type: "system", subtype: "init", session_id: "0b1c2d3e-aaaa" }), [{ type: "session", id: "0b1c2d3e-aaaa" }]);
  assert.deepEqual(runnerMessages({ type: "system", subtype: "hook_started", session_id: "0b1c2d3e-aaaa" }), []);
  assert.deepEqual(runnerMessages({ type: "result", subtype: "error_max_turns", total_cost_usd: 1 }), [{ type: "result", ok: false, text: "Stopped: error_max_turns", costUsd: 1 }]);
});
