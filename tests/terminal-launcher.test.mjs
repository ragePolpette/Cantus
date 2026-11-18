import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { lastConversation, openTerminal, personalConfigPath, planTerminal, readPersonalConfig, writeTerminalApp } from "../dist/index.js";

const target = { folder: "C:\\work\\shop-worktrees\\add-vat", command: "claude --resume 0b1c2d3e-aaaa-bbbb-cccc-1234567890ab" };
const config = (terminal) => ({ terminal });
const decode = (args) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
const tmp = (prefix) => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));

test("by default Cantus opens nothing: the two lines to copy", () => {
  const plan = planTerminal(target, { config: {} });
  assert.deepEqual([plan.app, plan.line, plan.action], ["lines", `cd "${target.folder}"\n${target.command}`, undefined]);
});

test("Windows Terminal: the line that runs is the one that was tried on a Windows PC, with the line typed", () => {
  const plan = planTerminal(target, { platform: "win32", config: config({ app: "wt" }), which: (program) => program === "wt.exe" });
  assert.equal(plan.problem, undefined);
  assert.equal(plan.line, `Start-Process wt.exe -ArgumentList @('-d','"${target.folder}"','--title','cantus-add-vat','powershell','-NoExit','-Command','${target.command}')`);
  assert.equal(plan.action.script, plan.line);
  assert.equal(planTerminal(target, { platform: "win32", config: config({ app: "wt" }), which: () => true }).line.includes("'pwsh'"), true, "pwsh when there is one");
  assert.match(planTerminal(target, { platform: "win32", config: config({ app: "wt" }), which: () => false }).problem, /wt\.exe\) was not found/);
  assert.match(planTerminal(target, { platform: "linux", config: config({ app: "wt" }), which: () => true }).problem, /Windows only/);
});

test("Warp: a tab configuration is written, opened by its address, and taken away again", async () => {
  const appdata = tmp("cantus-warp-");
  const plan = planTerminal(target, { platform: "win32", env: { APPDATA: appdata }, config: config({ app: "warp" }), which: () => true });
  assert.equal(plan.line, 'Start-Process "warp://tab_config/cantus-add-vat?new_window=true"');
  const file = path.join(appdata, "warp", "Warp", "data", "tab_configs", "cantus-add-vat.toml");
  assert.equal(fs.existsSync(file), false, "nothing is written by planning");
  const calls = [];
  const message = await openTerminal(plan, async (program, args) => {
    calls.push([program, decode(args)]);
    assert.equal(fs.existsSync(file), true, "the file is there when Warp is asked to open it");
    return { code: 0, output: "" };
  });
  assert.equal(message, "Warp opened.");
  assert.deepEqual(calls, [["powershell.exe", plan.line]], "the script goes to PowerShell encoded, so no quoting stands between");
  assert.equal(fs.readFileSync(file, "utf8"), `name = "cantus-add-vat"\n\n[[panes]]\nid = "main"\ntype = "terminal"\ndirectory = '${target.folder}'\ncommands = ['${target.command}']\n`);
  await assert.rejects(openTerminal(plan, async () => ({ code: 1, output: "boom" })), /Warp did not start: boom/);
});

test("a folder or a line that a shell would read as a command is refused", () => {
  for (const folder of ["C:\\a'; calc; '", 'C:\\a"b', "C:\\a&b", "C:\\a%PATH%", "C:\\a$x"]) {
    assert.match(planTerminal({ ...target, folder }, { platform: "win32", config: config({ app: "wt" }), which: () => true }).problem, /character a terminal would read/, folder);
  }
  assert.match(planTerminal({ ...target, command: "claude --resume x; calc" }, { platform: "win32", config: config({ app: "wt" }), which: () => true }).problem, /cannot be typed for you/);
});

test("a command of my own: program and arguments filled in, never through a shell; only from the personal settings", () => {
  assert.match(planTerminal(target, { config: config({ app: "custom" }) }).problem, /No command in the personal settings/);
  const plan = planTerminal(target, { config: config({ app: "custom", command: ["alacritty", "--working-directory", "{folder}", "-e", "pwsh", "-NoExit", "-Command", "{claude}"] }) });
  assert.deepEqual(plan.action.args.slice(0, 2), ["--working-directory", target.folder]);
  assert.equal(plan.action.args.at(-1), target.command);
});

test("the personal settings: a place outside every project, a broken file ignored, and no command written from the page", () => {
  assert.equal(personalConfigPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me"), path.join("C:\\Users\\me\\AppData\\Roaming", "cantus", "config.json"));
  assert.equal(personalConfigPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/me"), path.join("/x", "cantus", "config.json"));
  const file = path.join(tmp("cantus-personal-"), "cantus", "config.json");
  assert.deepEqual(readPersonalConfig(file), {}, "no file");
  writeTerminalApp("warp", file);
  assert.deepEqual(readPersonalConfig(file), { terminal: { app: "warp" } });
  assert.throws(() => writeTerminalApp("custom", file), /Write the command in/);
  assert.throws(() => writeTerminalApp("background", file), /Unknown terminal app/);
  fs.writeFileSync(file, JSON.stringify({ other: 1, terminal: { app: "warp", command: ["a", "{folder}"] } }));
  writeTerminalApp("custom", file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { other: 1, terminal: { app: "custom", command: ["a", "{folder}"] } }, "the rest of the file stays");
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(readPersonalConfig(file), {}, "a broken file never stops the map");
});

test("the conversation Claude Code kept for a folder: the newest one, none where nobody talked, in the store it is read from", () => {
  const home = tmp("cantus-claude-home-");
  const folder = tmp("cantus-folder-");
  const dir = path.join(home, ".claude", "projects", fs.realpathSync.native(folder).replace(/[^A-Za-z0-9]/g, "-"));
  assert.equal(lastConversation(folder, {}, home), undefined, "no store at all");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(lastConversation(folder, {}, home), undefined, "a folder with no conversation: `claude --continue` would say \"No conversation found\"");
  const write = (name, content, ageSeconds) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const at = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, at, at);
  };
  write("11111111-aaaa-bbbb-cccc-111111111111.jsonl", "{}\n", 300);
  write("22222222-aaaa-bbbb-cccc-222222222222.jsonl", "{}\n", 10);
  write("33333333-aaaa-bbbb-cccc-333333333333.jsonl", "", 1); // empty: nothing was said
  write("notes.txt", "x", 0);
  write("not an id.jsonl", "{}\n", 0);
  assert.equal(lastConversation(folder, {}, home), "22222222-aaaa-bbbb-cccc-222222222222");
  const elsewhere = tmp("cantus-config-dir-");
  assert.equal(lastConversation(folder, { CLAUDE_CONFIG_DIR: elsewhere }, home), undefined, "CLAUDE_CONFIG_DIR moves the store");
  assert.equal(lastConversation(path.join(folder, "other"), {}, home), undefined, "another folder");
});
