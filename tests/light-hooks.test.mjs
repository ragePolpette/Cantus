import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectState, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Every module a file loads, following the relative imports, and the packages it names. */
function loaded(entry, seen = new Set(), packages = new Set()) {
  if (seen.has(entry)) return { seen, packages };
  seen.add(entry);
  for (const [, specifier] of [...fs.readFileSync(entry, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g)].map((m) => [m[0], m[1] ?? m[2]])) {
    if (specifier.startsWith(".")) loaded(path.join(path.dirname(entry), specifier), seen, packages);
    else if (!specifier.startsWith("node:")) packages.add(specifier);
  }
  return { seen, packages };
}

test("the hooks that run after every tool call load no analysis, parser or SDK", () => {
  const { seen, packages } = loaded(path.join(dist, "hooks", "light-run.js"));
  assert.deepEqual([...packages], [], "no package at all");
  const heavy = [...seen].map((file) => path.relative(dist, file).split(path.sep).join("/")).filter((file) => /^(analysis|outputs|mcp|run|serve|context|map)\//.test(file));
  assert.deepEqual(heavy, []);
});

function runCli(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dist, "cli.js"), ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(input);
  });
}

test("the command line answers the prompt and tool hooks through the short way, as before", async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, session: true });
  t.after(() => server.close());
  const send = (prompt) => fetch(new URL("api/requests", server.url), { method: "POST", headers: { "x-cantus-token": server.token, "content-type": "application/json" }, body: JSON.stringify({ prompt, block: "src-orders" }) });

  assert.equal((await runCli(["hook", "user-prompt", "-C", root], JSON.stringify({ session_id: "s1" }))).stdout, "", "nothing waits");
  await send("Reject empty carts");
  const prompt = await runCli(["hook", "user-prompt"], JSON.stringify({ session_id: "s1", cwd: root }), { CLAUDE_PROJECT_DIR: root });
  assert.equal(prompt.status, 0);
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(prompt.stdout, /Reject empty carts/);

  await send("Second request");
  const tool = await runCli(["hook", "tool-use"], JSON.stringify({ session_id: "s1", tool_name: "Bash" }), { CLAUDE_PROJECT_DIR: root });
  assert.equal(JSON.parse(tool.stdout).hookSpecificOutput.hookEventName, "PostToolUse");

  await send("Third request");
  const stop = await runCli(["hook", "stop"], JSON.stringify({ session_id: "s1" }), { CLAUDE_PROJECT_DIR: root });
  assert.equal(JSON.parse(stop.stdout).decision, "block");

  const other = await runCli(["hook", "tool-use"], JSON.stringify({ session_id: "s1", agent_id: "sub" }), { CLAUDE_PROJECT_DIR: root });
  assert.equal(other.stdout, "", "a subagent takes nothing of the session's");
});

test("the permission hook tells the map the session asks for a permission, takes no work and prints nothing", async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, session: true });
  t.after(() => server.close());
  const headers = { "x-cantus-token": server.token, "content-type": "application/json" };
  const asked = async () => (await (await fetch(new URL("api/requests", server.url), { headers })).json());
  await fetch(new URL("api/requests", server.url), { method: "POST", headers, body: JSON.stringify({ prompt: "Reject empty carts", block: "src-orders" }) });

  const input = JSON.stringify({ session_id: "s1", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf node_modules" } });
  const permission = await runCli(["hook", "permission"], input, { CLAUDE_PROJECT_DIR: root });
  assert.equal(permission.status, 0);
  assert.equal(permission.stdout, "", "no decision: the prompt goes on as it would without Cantus");
  const after = await asked();
  assert.equal(after.seenVia, "permission");
  assert.equal(after.requests.filter((request) => request.status === "pending").length, 1, "the request written on the map is still waiting for the session");

  // A specialist's permission counts: the lead waits for it too.
  await runCli(["hook", "tool-use"], JSON.stringify({ session_id: "s1", tool_name: "Read", agent_id: "sub" }), { CLAUDE_PROJECT_DIR: root });
  await runCli(["hook", "permission"], JSON.stringify({ session_id: "s1", agent_id: "sub", tool_name: "Edit" }), { CLAUDE_PROJECT_DIR: root });
  assert.equal((await asked()).seenVia, "permission");

  // With no map open the hook is silent and does not fail.
  const none = await runCli(["hook", "permission"], input, { CLAUDE_PROJECT_DIR: path.join(root, "nowhere") });
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "");
});

test("the plugin asks Claude Code to run the permission hook the moment it shows a prompt", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin/hooks/hooks.json"), "utf8")).hooks;
  assert.deepEqual(hooks.PermissionRequest[0].hooks[0].args.slice(-2), ["hook", "permission"]);
  assert.equal(hooks.Notification, undefined, "the notification of the same prompt waits about six seconds, and in a terminal only when the person is away");
});
