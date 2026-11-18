import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentsFolderOutside, analyze, ensureAgentsFolder, exportClaudeAgents } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const link = (target, at) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");

test("agents are not written through a .claude that leads outside the project", () => {
  const root = copyFixture("shop");
  const main = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-main-"));
  fs.mkdirSync(path.join(main, "agents"));
  link(main, path.join(root, ".claude"));
  assert.equal(agentsFolderOutside(root), fs.realpathSync.native(main));
  const result = exportClaudeAgents(analyze(root, { model: shopModel(), skipGit: true }));
  assert.equal(result.blocked, fs.realpathSync.native(main));
  assert.deepEqual(result.written, []);
  assert.deepEqual(fs.readdirSync(path.join(main, "agents")), [], "the main checkout got nothing");
  ensureAgentsFolder(root);
  assert.deepEqual(fs.readdirSync(path.join(main, "agents")), []);
});

test("a .claude/agents link to somewhere outside is blocked too, and a real folder or a link inside is not", () => {
  const root = copyFixture("shop");
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-elsewhere-"));
  fs.mkdirSync(path.join(root, ".claude"));
  link(elsewhere, path.join(root, ".claude", "agents"));
  assert.ok(agentsFolderOutside(root));
  fs.rmSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, "shared"));
  link(path.join(root, "shared"), path.join(root, ".claude", "agents"));
  assert.equal(agentsFolderOutside(root), undefined, "a link that stays inside the project is fine");
  assert.ok(exportClaudeAgents(analyze(root, { model: shopModel(), skipGit: true })).written.length > 0);
  assert.equal(agentsFolderOutside(copyFixture("shop")), undefined);
});
