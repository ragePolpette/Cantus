import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EDIT_LEDGER_FILE, EditLedger, ProjectState, TaskManager, readServeInfo, startMapServer } from "../dist/index.js";
import { fileDiff, settleEdits } from "../dist/state/changes.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function mappedRepo() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/\n");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("add", "-A");
  run("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  return root;
}

const credited = (ops) => ops.filter((op) => op.agent).map((op) => [op.text, op.agent]);

test("the ledger credits an agent with the lines its edit added, and nobody with the lines typed between edits", () => {
  const ledger = new EditLedger();
  ledger.before("t1", "a.ts", "one\ntwo\n");
  ledger.after("t1", "a.ts", "one\nagent\ntwo\n", "Claude Code");
  // The developer types a line, then a subagent edits.
  ledger.before("t2", "a.ts", "mine\none\nagent\ntwo\n");
  ledger.after("t2", "a.ts", "mine\none\nagent\ntwo\nhelper\n", "block-src-a");
  assert.deepEqual(ledger.authors("a.ts", "mine\none\nagent\ntwo\nhelper\nlater\n"), [undefined, undefined, "Claude Code", undefined, "block-src-a", undefined]);
  // Credits follow the lines as the file moves, and go when the lines go.
  assert.deepEqual(ledger.authors("a.ts", "top\none\nagent\ntwo\n"), [undefined, undefined, "Claude Code", undefined]);
  assert.deepEqual(ledger.touched(), ["a.ts"]);
  assert.deepEqual(ledger.authors("a.ts", "one\ntwo\n"), [undefined, undefined]);
  assert.deepEqual(ledger.touched(), [], "a file with no agent lines left is forgotten");

  ledger.after("missing", "b.ts", "x\n", "Claude Code");
  assert.deepEqual(ledger.authors("b.ts", "x\n"), [undefined], "an edit seen only after the fact is not credited");
  ledger.before("new", "c.ts", undefined);
  ledger.after("new", "c.ts", "created\n", "Claude Code");
  assert.deepEqual(ledger.authors("c.ts", "created\n"), ["Claude Code"], "a file the agent created is all its own");
});

/** Runs the hook as Claude Code would, in its own process (the map server here must keep answering). */
async function hook(root, event, input, env = {}) {
  const child = promisify(execFile)(process.execPath, [CLI, "hook", event], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root, CANTUS_EDITS_RECORDED: "", ...env } });
  child.child.stdin.end(JSON.stringify(input));
  await child;
}

function get(server, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.port, path: pathname, headers: { "x-cantus-token": server.token } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve(JSON.parse(raw)));
    }).on("error", reject);
  });
}

test("the hooks tell the open map which lines an agent wrote; the file view marks them", async (t) => {
  const root = mappedRepo();
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());
  assert.equal(readServeInfo(root).token, server.token, "the hooks find the token next to the URL");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, ".cantus/cache/serve.json")).mode & 0o077, 0, "only this user can read it");

  const file = path.join(root, "src/pricing/index.ts");
  const input = { session_id: "s1", tool_use_id: "toolu_1", tool_name: "Edit", cwd: root, tool_input: { file_path: file } };
  await hook(root, "pre-edit", input);
  fs.appendFileSync(file, "export const vat = 0.22;\n");
  await hook(root, "post-edit", input);
  fs.appendFileSync(file, "// my own note\n");
  const sub = { ...input, tool_use_id: "toolu_2", agent_type: "block-src-pricing" };
  await hook(root, "pre-edit", sub, { CANTUS_TASK: "7" });
  fs.appendFileSync(file, "export const rounding = 2;\n");
  await hook(root, "post-edit", sub, { CANTUS_TASK: "7" });

  const diff = await get(server, "/api/file-diff?path=src/pricing/index.ts");
  assert.deepEqual(diff.ops.filter((op) => op.type === "add").map((op) => op.text), ["export const vat = 0.22;", "// my own note", "export const rounding = 2;"]);
  assert.deepEqual(credited(diff.ops), [
    ["export const vat = 0.22;", "Claude Code"],
    ["export const rounding = 2;", "block-src-pricing · map task 7"],
  ]);

  // A session whose runner records its own edits does not report them twice.
  const orders = path.join(root, "src/orders/index.ts");
  const own = { ...input, tool_use_id: "toolu_3", tool_input: { file_path: orders } };
  await hook(root, "pre-edit", own, { CANTUS_EDITS_RECORDED: "1" });
  fs.appendFileSync(orders, "export const x = 1;\n");
  await hook(root, "post-edit", own, { CANTUS_EDITS_RECORDED: "1" });
  assert.deepEqual(credited((await get(server, "/api/file-diff?path=src/orders/index.ts")).ops), []);
});

test("a map task's edits are credited to the task through its runner", async () => {
  const root = mappedRepo();
  const state = new ProjectState(root);
  const runner = (request) => ({
    async *[Symbol.asyncIterator]() {
      const file = path.join(request.cwd, "src/checkout/cart.ts");
      const decision = await request.canUseTool("Edit", { file_path: file }, request.abort.signal);
      if (decision.allow) {
        request.onEdit("before", file, "toolu_9", "block-src-checkout");
        fs.appendFileSync(file, "export const discount = 0.1;\n");
        request.onEdit("after", file, "toolu_9", "block-src-checkout");
      }
      yield { type: "result", ok: true, text: "done" };
    },
  });
  const tasks = new TaskManager(state, runner);
  const task = tasks.start({ block: "src-checkout", prompt: "Add a discount", mode: "edit" });
  for (let i = 0; i < 200 && !task.approvals[0]; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  tasks.decide(task.id, task.approvals[0].id, { allow: true });
  await tasks.wait(task.id);
  assert.deepEqual(credited(fileDiff(root, "src/checkout/cart.ts", state.edits).ops), [["export const discount = 0.1;", `block-src-checkout · map task ${task.id}`]]);
});

test("the Agent SDK runner reports edits from in-process hooks and keeps the plugin's hooks quiet", async () => {
  const { editHooks } = await import("../dist/run/sdk-runner.js");
  const calls = [];
  const options = editHooks((...args) => calls.push(args));
  assert.equal(options.env.CANTUS_EDITS_RECORDED, "1");
  assert.equal(options.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
  const signal = new AbortController().signal;
  const base = { session_id: "s", transcript_path: "", cwd: "/project", tool_name: "Edit", tool_use_id: "toolu_5" };
  await options.hooks.PreToolUse[0].hooks[0]({ ...base, hook_event_name: "PreToolUse", tool_input: { file_path: "src/a.ts" } }, "toolu_5", { signal });
  await options.hooks.PostToolUse[0].hooks[0]({ ...base, hook_event_name: "PostToolUse", agent_type: "block-x", tool_input: { file_path: "/project/src/a.ts" }, tool_response: {} }, "toolu_5", { signal });
  assert.deepEqual(calls, [
    ["before", path.resolve("/project", "src/a.ts"), "toolu_5", undefined],
    ["after", path.resolve("/project", "src/a.ts"), "toolu_5", "block-x"],
  ]);
});

const commit = (root, message) => {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: root, stdio: "pipe" });
};

test("the record of who wrote what survives the map: a new session reads it back", async (t) => {
  const root = mappedRepo();
  const file = path.join(root, "src/pricing/index.ts");
  const input = { session_id: "s1", tool_use_id: "toolu_1", tool_name: "Edit", cwd: root, tool_input: { file_path: file } };

  const first = await startMapServer(new ProjectState(root), { port: 0 });
  await hook(root, "pre-edit", input);
  fs.appendFileSync(file, "export const vat = 0.22;\n");
  await hook(root, "post-edit", { ...input, agent_type: "block-src-pricing" });
  await first.close();
  assert.ok(fs.existsSync(path.join(root, EDIT_LEDGER_FILE)), "kept in Cantus's cache, which git ignores");

  // The developer works on, with no map open; then a later session opens the map again.
  fs.appendFileSync(file, "// typed while the map was closed\n");
  const second = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => second.close());
  const diff = await get(second, "/api/file-diff?path=src/pricing/index.ts");
  assert.deepEqual(credited(diff.ops), [["export const vat = 0.22;", "block-src-pricing"]]);
  const view = await get(second, "/api/view");
  assert.deepEqual(view.changes.files["src/pricing/index.ts"].agents, ["block-src-pricing"]);
});

test("a commit settles the record: committed lines are no longer credited, and the store empties", async (t) => {
  const root = mappedRepo();
  const state = new ProjectState(root);
  const server = await startMapServer(state, { port: 0 });
  t.after(() => server.close());
  const file = path.join(root, "src/pricing/index.ts");
  const input = { session_id: "s1", tool_use_id: "toolu_1", tool_name: "Edit", cwd: root, tool_input: { file_path: file } };
  await hook(root, "pre-edit", input);
  fs.appendFileSync(file, "export const vat = 0.22;\n");
  await hook(root, "post-edit", input);
  assert.deepEqual(state.edits.touched(), ["src/pricing/index.ts"]);

  commit(root, "vat");
  const view = await get(server, "/api/view");
  assert.equal(view.changes.files["src/pricing/index.ts"], undefined, "nothing left to show");
  assert.deepEqual(state.edits.touched(), []);
  assert.equal(fs.existsSync(path.join(root, EDIT_LEDGER_FILE)), false, "nothing left to keep");

  // Removing the line and writing it again by hand is not the agent's work.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("export const vat = 0.22;\n", ""));
  fs.appendFileSync(file, "export const vat = 0.22;\n");
  assert.deepEqual(credited((await get(server, "/api/file-diff?path=src/pricing/index.ts")).ops), []);
});

test("a commit keeps the credit of lines still not committed, in the same file", () => {
  const root = mappedRepo();
  const ledger = new EditLedger(path.join(root, EDIT_LEDGER_FILE));
  const file = "src/pricing/index.ts";
  const absolute = path.join(root, file);
  ledger.before("a", file, fs.readFileSync(absolute, "utf8"));
  fs.appendFileSync(absolute, "export const one = 1;\n");
  ledger.after("a", file, fs.readFileSync(absolute, "utf8"), "Claude Code");
  commit(root, "one");
  ledger.before("b", file, fs.readFileSync(absolute, "utf8"));
  fs.appendFileSync(absolute, "export const two = 2;\n");
  ledger.after("b", file, fs.readFileSync(absolute, "utf8"), "block-src-pricing");
  settleEdits(root, ledger);
  assert.deepEqual(ledger.agentsOf(file), ["block-src-pricing"]);
  assert.deepEqual(credited(fileDiff(root, file, ledger).ops), [["export const two = 2;", "block-src-pricing"]]);
  assert.deepEqual(new EditLedger(path.join(root, EDIT_LEDGER_FILE)).agentsOf(file), ["block-src-pricing"], "and so does the stored copy");
});

test("two processes of one project add to the same store without erasing each other, and a damaged store is ignored", () => {
  const store = path.join(copyFixture("shop"), EDIT_LEDGER_FILE);
  const a = new EditLedger(store);
  const b = new EditLedger(store);
  a.before("1", "a.ts", "x\n");
  a.after("1", "a.ts", "x\nfrom a\n", "agent-a");
  b.before("2", "b.ts", "y\n");
  b.after("2", "b.ts", "y\nfrom b\n", "agent-b");
  const reread = new EditLedger(store);
  assert.deepEqual(reread.touched().sort(), ["a.ts", "b.ts"]);
  assert.deepEqual(reread.authors("b.ts", "y\nfrom b\n"), [undefined, "agent-b"]);

  fs.writeFileSync(store, "{ not json");
  assert.deepEqual(new EditLedger(store).touched(), []);
  fs.writeFileSync(store, JSON.stringify({ version: 2, agents: [], files: {} }));
  assert.deepEqual(new EditLedger(store).touched(), [], "a store from another version is not read");
});
