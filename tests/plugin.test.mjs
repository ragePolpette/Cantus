import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { analyze, exportClaudeAgents, handleHook, readProjectIndex, writeProjectIndex } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "dist", "cli.js");

function indexedShop() {
  const root = copyFixture("shop");
  writeProjectIndex(root, analyze(root, { model: shopModel(), skipGit: true }));
  return root;
}

test("one subagent per block, fetching its briefing over MCP; stale ones removed", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  model.blocks.find((block) => block.id === "src-orders").description = "Creates and stores orders: never deletes them.";
  const first = exportClaudeAgents(analyze(root, { model, skipGit: true }));
  assert.equal(first.written.length, 7, "one per block, plus the ad-hoc scope agent");

  const agent = fs.readFileSync(path.join(root, ".claude/agents/block-src-orders.md"), "utf8");
  assert.match(agent, /^---\nname: block-src-orders\ndescription: "Specialist of the Orders block \(src\/orders\): Creates and stores orders: never deletes them\. Delegate/, "description is quoted, so colons keep the YAML valid");
  assert.match(agent, /`block_context` for block `src-orders`/);
  assert.doesNotMatch(agent, /export declare function/, "no static copy of the briefing");

  assert.equal(exportClaudeAgents(analyze(root, { model, skipGit: true })).written.length, 0, "deterministic");

  fs.writeFileSync(path.join(root, ".claude/agents/block-mine.md"), "---\nname: block-mine\n---\nhand written");
  const smaller = { ...model, blocks: model.blocks.filter((block) => block.id !== "src-db") };
  const second = exportClaudeAgents(analyze(root, { model: smaller, skipGit: true }));
  assert.deepEqual(second.removed, [".claude/agents/block-src-db.md"]);
  assert.ok(fs.existsSync(path.join(root, ".claude/agents/block-mine.md")), "files Cantus did not generate are kept");
});

test("cantus agents says when .claude/agents is new: an open session loads those only after a restart", () => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const run = () => spawnSync(process.execPath, [cli, "agents", "-C", root], { encoding: "utf8" });
  assert.match(run().stdout, /The \.claude\/agents folder is new: .*after a restart \(`claude --continue`/);
  assert.doesNotMatch(run().stdout, /folder is new/);
  assert.equal(exportClaudeAgents(analyze(copyFixture("shop"), { model: shopModel(), skipGit: true })).createdFolder, true);

  const fresh = copyFixture("shop");
  assert.equal(spawnSync(process.execPath, [cli, "analyze", "--write", "-C", fresh], { encoding: "utf8" }).status, 0);
  assert.ok(fs.statSync(path.join(fresh, ".claude/agents")).isDirectory(), "the map makes the folder, before any session starts");
  assert.doesNotMatch(spawnSync(process.execPath, [cli, "agents", "-C", fresh], { encoding: "utf8" }).stdout, /folder is new/);
});

test("before an edit: the file's block, and who calls its exports", () => {
  const root = indexedShop();
  const input = { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/orders/index.ts") } };

  const main = handleHook("pre-edit", input, root);
  assert.equal(main.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(main.hookSpecificOutput.permissionDecision, undefined, "never decides permissions");
  assert.match(main.hookSpecificOutput.additionalContext, /- createOrder ← src\/checkout\/index\.ts:11/);
  assert.doesNotMatch(main.hookSpecificOutput.additionalContext, /belongs to block/);

  const specialist = handleHook("pre-edit", { ...input, agent_type: "block-src-checkout" }, root);
  assert.match(specialist.hookSpecificOutput.additionalContext, /belongs to block `src-orders` \(Orders\), not to `src-checkout`/);

  assert.equal(handleHook("pre-edit", { ...input, tool_input: { file_path: path.join(root, "src/web/checkout-page.ts") } }, root), undefined, "nothing to say, no output");
  assert.equal(handleHook("pre-edit", { ...input, tool_input: { file_path: path.join(root, "README.md") } }, root), undefined);
  assert.equal(handleHook("pre-edit", { ...input, tool_input: { file_path: "/etc/passwd" } }, root), undefined);
});

test("after an edit: changed or removed exports that other blocks use, and look-alike new exports", () => {
  const root = indexedShop();
  const file = path.join(root, "src/orders/index.ts");
  const input = { cwd: root, tool_name: "Edit", tool_input: { file_path: file } };
  assert.equal(handleHook("post-edit", input, root), undefined, "no change, no output");

  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("createOrder(id: string, total: number): Order", "createOrder(id: string, total: number, currency: string): Order"));
  assert.match(handleHook("post-edit", input, root).hookSpecificOutput.additionalContext, /- createOrder changed its declaration; other blocks call it: src\/checkout\/index\.ts:11/);

  fs.writeFileSync(file, "export interface Order { id: string; total: number }\nexport function discount(total: number): number { return total; }\n");
  const removed = handleHook("post-edit", input, root).hookSpecificOutput.additionalContext;
  assert.match(removed, /- createOrder is no longer exported, but other blocks use it: src\/checkout\/index\.ts:11/);
  assert.match(removed, /the new export discount has the same name as discount in src\/pricing\/index\.ts \(block `src-pricing`\)/);

  fs.writeFileSync(file, "export const broken = (;");
  assert.equal(handleHook("post-edit", input, root), undefined, "mid-edit syntax errors stay silent");
});

test("session start: a short map from the existing index", () => {
  const root = indexedShop();
  const result = handleHook("session-start", {}, root);
  assert.match(result.hookSpecificOutput.additionalContext, /^This project has a Cantus map: 6 blocks \(src-web, src-checkout, src-orders, src-pricing, src-payments, src-db\)\./, "blocks in map order");
  assert.match(result.hookSpecificOutput.additionalContext, /touches more than one block, you coordinate[^\n]*Don't edit those blocks yourself, unless the whole change is minimal[^\n]*If any piece needs you to explore a block, delegate\. A task that stays inside one block you may do yourself/);
  assert.match(result.hookSpecificOutput.additionalContext, /No block specialists are installed yet: `cantus agents` creates them/);
  assert.ok(fs.statSync(path.join(root, ".claude/agents")).isDirectory(), "made for the next session: Claude Code watches the folder only if it existed before the session");
  fs.writeFileSync(path.join(root, ".claude/agents/block-src-web.md"), "---\nname: block-src-web\n---\n");
  assert.doesNotMatch(handleHook("session-start", {}, root).hookSpecificOutput.additionalContext, /No block specialists/);
  const mono = copyFixture("mono");
  assert.match(handleHook("session-start", {}, mono).hookSpecificOutput.additionalContext, /^There is no saved Cantus map or index\. Run `cantus index`/);
  assert.equal(fs.existsSync(path.join(mono, ".claude")), false, "and no folder created in a project without a map");
  const notes = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-notes-"));
  fs.writeFileSync(path.join(notes, "diary.md"), "# today\n");
  assert.equal(handleHook("session-start", {}, notes), undefined, "a folder with no project manifest: nothing to say");
});

test("session start without a saved map says what still works, and does not hand out specialists", () => {
  const root = copyFixture("shop");
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  assert.equal(readProjectIndex(root).inferred, true);
  const text = handleHook("session-start", {}, root).hookSpecificOutput.additionalContext;
  assert.match(text, /^Cantus is available here without a saved map: \d+ block\(s\) are inferred from the folders/);
  assert.match(text, /`callers` before changing or removing an export/);
  assert.doesNotMatch(text, /specialist|delegat|you coordinate/);
});

test("concurrent session starts do not launch index processes and edits wait for an explicit index", async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel()));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-home-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const probe = path.join(home, "probe.mjs");
  const unexpected = path.join(home, "unexpected-index");
  fs.writeFileSync(probe, `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const { spawn } = childProcess;
childProcess.spawn = (command, args, ...options) => {
  if (args?.[1] === "index") {
    fs.writeFileSync(${JSON.stringify(unexpected)}, "index");
    throw new Error("Unexpected automatic indexing");
  }
  return spawn(command, args, ...options);
};
syncBuiltinESMExports();
`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` };
  const run = promisify(execFile);
  await Promise.all(["startup", "resume", "clear", "compact", "startup", "startup"].map((source, i) => new Promise((resolve, reject) => {
    const cwd = i === 5 ? root : home;
    const child = execFile(process.execPath, [cli, "hook", "session-start", "-C", cwd], { cwd, env }, (error) => error ? reject(error) : resolve());
    child.stdin.end(JSON.stringify({ cwd, source }));
  })));
  assert.equal(fs.existsSync(unexpected), false);
  assert.equal(fs.existsSync(path.join(home, ".cantus")), false);

  const input = { cwd: root, tool_input: { file_path: path.join(root, "src/orders/index.ts") } };
  assert.equal(handleHook("pre-edit", input, root), undefined);
  assert.equal(handleHook("post-edit", input, root), undefined);
  assert.equal(readProjectIndex(root), undefined);
  await run(process.execPath, [cli, "index", "-C", root]);
  assert.ok(readProjectIndex(root));
});

test("cantus hook reads Claude Code's JSON on stdin and never fails the tool", () => {
  const root = indexedShop();
  const run = (event, input, env = {}) =>
    spawnSync(process.execPath, [cli, "hook", event], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env } });

  const ok = run("pre-edit", { cwd: root, tool_name: "Write", tool_input: { file_path: "src/orders/index.ts" } });
  assert.equal(ok.status, 0);
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /createOrder/);

  const garbage = run("pre-edit", "{not json");
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "");
  assert.match(fs.readFileSync(path.join(root, ".cantus/hooks.log"), "utf8"), /pre-edit: SyntaxError/);

  const indexed = spawnSync(process.execPath, [cli, "index", "-C", copyFixture("shop")], { encoding: "utf8" });
  assert.equal(indexed.status, 0);
  assert.ok(readProjectIndex(root).exports.some((entry) => entry.name === "createOrder" && entry.shape.includes("createOrder")));
});

test("the plugin and the marketplace entry are consistent", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "plugin/.claude-plugin/plugin.json"), "utf8"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin/marketplace.json"), "utf8"));
  const hooks = JSON.parse(fs.readFileSync(path.join(repo, "plugin/hooks/hooks.json"), "utf8"));
  const mcp = JSON.parse(fs.readFileSync(path.join(repo, "plugin/.mcp.json"), "utf8"));
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].source, "./plugin");
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PermissionRequest", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
  assert.deepEqual(mcp.mcpServers.cantus, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/cantus.mjs", "mcp", "--channels"] }, "a real executable: Claude Code cannot start the cantus.cmd shim that npm installs on Windows");
  for (const entry of Object.values(hooks.hooks).flat().flatMap((group) => group.hooks)) {
    assert.equal(entry.command, "node");
    assert.equal(entry.args[0], "${CLAUDE_PLUGIN_ROOT}/scripts/cantus.mjs");
  }
  assert.match(fs.readFileSync(path.join(repo, "plugin/skills/cantus/SKILL.md"), "utf8"), /^---\nname: cantus\ndescription: /);
  const command = fs.readFileSync(path.join(repo, "plugin/commands/agents.md"), "utf8");
  assert.match(command, /^---\ndescription: .+\nallowed-tools: Bash\(cantus agents:\*\)\n---\n/, "/cantus:agents regenerates the specialists, and may run only that");
  assert.match(command, /^!`cantus agents`$/m);
});

test("session start outlines a small map with what each block does and uses, and leaves a large one to the map tool", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  model.blocks.find((block) => block.id === "src-orders").description = "Creates and stores orders.\nNever deletes them.";
  model.groups = [{ id: "checkout-flow", name: "Checkout flow", blocks: ["src-checkout", "src-orders"] }];
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  writeProjectIndex(root, analyze(root, { model, skipGit: true }), model);

  const text = handleHook("session-start", {}, root).hookSpecificOutput.additionalContext;
  assert.match(text, /^This project has a Cantus map: 6 blocks \(src-web/);
  assert.match(text, /\nBlocks, what each is for and what it uses:\n- `src-web` \(interface\): Uses src-checkout\./);
  assert.match(text, /\n- `src-orders` \(domain\): Creates and stores orders\. Never deletes them\. Uses src-db\./);
  assert.match(text, /\n- `src-db` \(infrastructure\)\n|\n- `src-db` \(infrastructure\)$/m, "a block with neither description nor arrows is a bare line");
  assert.match(text, /\nGroups, saved scopes for block_context: checkout-flow \(src-checkout, src-orders\)\./);
  assert.ok(text.indexOf("Blocks, what each is for") < text.indexOf("Use the Cantus MCP tools"), "the outline comes before the instructions");

  const big = { ...model, blocks: Array.from({ length: 60 }, (_, i) => ({ id: `src-b${i}`, name: `B${i}`, layer: "domain", include: [`src/b${i}`], description: "x".repeat(150) })), dependencies: [], groups: [] };
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(big, null, 2));
  writeProjectIndex(root, analyze(root, { model: big, skipGit: true }), big);
  const large = handleHook("session-start", {}, root).hookSpecificOutput.additionalContext;
  assert.match(large, /^This project has a Cantus map: 60 blocks \(src-b0/);
  assert.doesNotMatch(large, /Blocks, what each is for/, "too large for an outline");
});

test("a specialist editing a test or a changelog no block owns is not told it is outside every block", () => {
  const root = indexedShop();
  const pre = (file) => handleHook("pre-edit", { cwd: root, tool_name: "Edit", agent_type: "block-src-orders", tool_input: { file_path: path.join(root, file) } }, root);
  assert.equal(pre("CHANGELOG.md"), undefined);
  assert.equal(pre("test/orders.test.mjs"), undefined);
});

test("the plugin's launcher finds cantus' cli.js behind the PATH entry, on Linux (a link) and on Windows (a .cmd shim)", async () => {
  const { findCantusCli } = await import(pathToFileURL(path.join(repo, "plugin/scripts/cantus.mjs")).href);
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-launcher-"));
  const cliFile = (dir) => {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist/cli.js"), "");
    return fs.realpathSync(path.join(dir, "dist/cli.js"));
  };

  if (process.platform !== "win32") {
    const linux = path.join(base, "linux");
    const target = cliFile(path.join(linux, "lib/node_modules/cantus"));
    fs.mkdirSync(path.join(linux, "bin"));
    fs.symlinkSync(target, path.join(linux, "bin/cantus"));
    assert.equal(findCantusCli(`${path.join(base, "nothing")}${path.delimiter}${path.join(linux, "bin")}`), target);
  }

  // npm's global layout on Windows: cantus.cmd (and cantus) next to node_modules/cantus
  const windows = path.join(base, "windows");
  const installed = cliFile(path.join(windows, "node_modules/cantus"));
  fs.writeFileSync(path.join(windows, "cantus.cmd"), "@echo off\r\nnode cli.js %*\r\n");
  assert.equal(findCantusCli(windows), installed);

  assert.equal(findCantusCli(path.join(base, "empty")), undefined, "nothing on the PATH: the launcher falls back to a shell and explains");
});

test("the launcher runs the hooks and the CLI like the cantus command", { skip: process.platform === "win32" && "the link to cli.js needs symlink rights" }, () => {
  const bin = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-bin-"));
  fs.symlinkSync(cli, path.join(bin, "cantus"));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const launcher = path.join(repo, "plugin/scripts/cantus.mjs");
  const version = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8", env });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /cantus/i);

  const root = indexedShop();
  const hook = spawnSync(process.execPath, [launcher, "hook", "pre-edit"], { input: JSON.stringify({ cwd: root, tool_name: "Write", tool_input: { file_path: "src/orders/index.ts" } }), encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(hook.status, 0);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /createOrder/, "stdin reaches the hook, its answer comes back");

  const missing = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8", env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /cantus command was not found on the PATH/);
});

test("/cantus:verify reads the user's words and does not paste them into the command", () => {
  const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin/commands/verify.md"), "utf8");
  assert.doesNotMatch(text, /cantus verify[^\n]*\$ARGUMENTS/, "the arguments are free text, not options");
  for (const option of ["--about", "--base", "--head", "--no-tests", "--tests", "--no-deliver"]) assert.ok(text.includes(option), `${option} is named`);
  assert.match(text, /no test command is configured/);
});
