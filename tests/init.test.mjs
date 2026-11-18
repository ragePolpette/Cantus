import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyFixture } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const posix = process.platform !== "win32";

/** A folder with a fake `claude` first on the PATH: it logs its arguments and answers like the real one would. */
function fakeBin({ plugin = false, registered = false, present = true } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-bin-"));
  const log = path.join(dir, "calls.log");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (${!present} ) process.exit(1);
if (args[0] === "--version") console.log("2.1.0 (fake)");
else if (args[0] === "plugin" && args[1] === "list") console.log(${JSON.stringify(plugin ? "cantus@cantus  enabled" : "no plugins")});
else if (args[0] === "mcp" && args[1] === "get") process.exit(${registered ? 0 : 1});
`;
  fs.writeFileSync(path.join(dir, "claude"), script, { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

function init(root, args, bin) {
  const env = { ...process.env, ...(bin ? { PATH: `${bin.dir}${path.delimiter}${process.env.PATH}` } : {}) };
  return spawnSync(process.execPath, [cli, "init", "-C", root, "--no-serve", ...args], { encoding: "utf8", env, stdin: "ignore" });
}

function git(root, ...args) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function listing(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else out.push(`${path.relative(root, file)}:${fs.statSync(file).size}`);
    }
  };
  walk(root);
  return out.sort();
}

test("init on a new project saves the map, the notes and the specialists, and a second run changes nothing", { skip: !posix }, () => {
  const root = copyFixture("shop");
  git(root, "init", "-q", "-b", "main");
  const bin = fakeBin();
  const first = init(root, ["--yes"], bin);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /files read/);
  assert.ok(fs.existsSync(path.join(root, ".cantus", "model.json")));
  assert.ok(fs.existsSync(path.join(root, ".cantus", ".gitignore")));
  assert.ok(fs.existsSync(path.join(root, ".claude", "agents")));
  assert.ok(fs.readdirSync(path.join(root, ".claude", "agents")).length > 0);
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "after init");
  const second = init(root, ["--yes"], bin);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(git(root, "status", "--porcelain").trim(), "", "a second init changed files");
});

test("init without a terminal and without --yes does not write notes or specialists", { skip: !posix }, () => {
  const root = copyFixture("shop");
  const run = init(root, [], fakeBin());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Notes skipped/);
  assert.ok(fs.existsSync(path.join(root, ".cantus", "model.json")), "the map is under .cantus: no question needed");
  assert.ok(!fs.existsSync(path.join(root, ".claude", "agents")) || fs.readdirSync(path.join(root, ".claude", "agents")).length === 0);
  const notes = listing(root).filter((file) => /(^|[\\/])(AGENTS|CLAUDE)\.md:/.test(file));
  assert.deepEqual(notes, []);
});

test("init --dry-run writes nothing", { skip: !posix }, () => {
  const root = copyFixture("shop");
  const before = listing(root);
  const run = init(root, ["--dry-run", "--yes", "--mcp"], fakeBin());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dry run/);
  assert.deepEqual(listing(root), before);
});

test("init in a folder with nothing it reads stops with a clear message and creates nothing", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-empty-"));
  fs.writeFileSync(path.join(root, "README.md"), "# nothing\n");
  fs.writeFileSync(path.join(root, "main.rb"), "puts 1\n");
  const run = init(root, ["--yes"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Nothing to map/);
  assert.ok(!fs.existsSync(path.join(root, ".cantus")));
});

test("init outside git says what is lost and goes on", () => {
  const root = copyFixture("shop");
  const run = init(root, ["--yes"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /git repository|git is not on the PATH/);
  assert.ok(fs.existsSync(path.join(root, ".cantus", "model.json")));
});

test("init refuses a partial analysis before writing a map or agent files, including dry runs", () => {
  for (const args of [["--yes"], ["--dry-run", "--yes"]]) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-parse-error-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/good.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "src/bad.ts"), "export function broken( {\n");
    const run = init(root, args);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /Cannot initialize: 1 analysis error/);
    assert.match(run.stderr, /src\/bad\.ts|src\\bad\.ts/);
    assert.doesNotMatch(run.stdout, /code matches the map|Saved .*model\.json/);
    assert.ok(!fs.existsSync(path.join(root, ".cantus/model.json")));
    assert.ok(!fs.existsSync(path.join(root, "AGENTS.md")));
    assert.ok(!fs.existsSync(path.join(root, "src/AGENTS.md")));
    assert.ok(!fs.existsSync(path.join(root, ".claude/agents")));
    if (args.includes("--dry-run")) assert.ok(!fs.existsSync(path.join(root, ".cantus")));
  }
});

test("a failed init preserves the existing map, notes and specialists", () => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const first = init(root, ["--yes"]);
  assert.equal(first.status, 0, first.stderr);
  const files = [".cantus/model.json", "AGENTS.md", "src/orders/AGENTS.md", ...fs.readdirSync(path.join(root, ".claude/agents")).map((file) => `.claude/agents/${file}`)];
  const before = files.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  fs.writeFileSync(path.join(root, "src/orders/index.ts"), "export function broken( {\n");
  const run = init(root, ["--yes"]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /Cannot initialize/);
  assert.deepEqual(files.map((file) => fs.readFileSync(path.join(root, file), "utf8")), before);
});

test("init leaves the MCP alone when the plugin is installed, and registers it for the user only with --mcp", { skip: !posix }, () => {
  const withPlugin = fakeBin({ plugin: true });
  const a = init(copyFixture("shop"), ["--yes", "--mcp"], withPlugin);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /plugin is installed/);
  assert.ok(!withPlugin.calls().some((call) => call.startsWith("mcp add")));

  const without = fakeBin();
  const hint = init(copyFixture("shop"), ["--yes"], without);
  assert.match(hint.stdout, /claude plugin install cantus@cantus/);
  assert.ok(!without.calls().some((call) => call.startsWith("mcp add")), "no registration without --mcp");

  const register = fakeBin();
  const b = init(copyFixture("shop"), ["--yes", "--mcp"], register);
  assert.equal(b.status, 0, b.stderr);
  const add = register.calls().find((call) => call.startsWith("mcp add"));
  assert.ok(add, "mcp add was called");
  assert.match(add, /^mcp add --scope local cantus -- .*cli\.js mcp$/);
  assert.ok(!fs.existsSync(path.join(path.dirname(register.dir), ".mcp.json")));
});

test("init skips the registration when the MCP server is already known", { skip: !posix }, () => {
  const known = fakeBin({ registered: true });
  const run = init(copyFixture("shop"), ["--yes", "--mcp"], known);
  assert.match(run.stdout, /already registered/);
  assert.ok(!known.calls().some((call) => call.startsWith("mcp add")));
});
