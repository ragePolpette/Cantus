import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, exportClaudeAgents, saveGroup } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const flow = { id: "checkout-flow", name: "Checkout flow", blocks: ["src-checkout", "src-pricing"] };

function agents(mcp) {
  const model = saveGroup({ ...shopModel(), ...(mcp ? { agent: { mcp } } : {}) }, flow);
  const root = copyFixture("shop");
  exportClaudeAgents(analyze(root, { model, skipGit: true }), model);
  return (name) => fs.readFileSync(path.join(root, ".claude/agents", `${name}.md`), "utf8");
}

test("specialists inherit the session's tools, the user's MCP servers included, unless the map takes some away", () => {
  const read = agents();
  for (const name of ["block-src-pricing", "group-checkout-flow", "cantus-scope"]) {
    assert.doesNotMatch(read(name), /^(tools|disallowedTools):/m, `${name} has no tool restriction`);
  }
});

test("agent.mcp writes disallowedTools into the specialists: all of them, or one block or group", () => {
  const read = agents({ specialists: { deny: ["jenkins"] }, blocks: { "src-pricing": { deny: ["db", "mcp__bitbucket__merge_pr", "jenkins"] }, "checkout-flow": { deny: ["db"] } } });
  const front = (name) => /^disallowedTools: (.*)$/m.exec(read(name))?.[1];
  assert.equal(front("block-src-orders"), "mcp__jenkins");
  assert.equal(front("block-src-pricing"), "mcp__jenkins, mcp__db, mcp__bitbucket__merge_pr");
  assert.equal(front("group-checkout-flow"), "mcp__jenkins, mcp__db");
  assert.equal(front("cantus-scope"), "mcp__jenkins");
  assert.match(read("block-src-pricing"), /^---\nname: block-src-pricing\ndescription: .*\ndisallowedTools: .*\n---\n/);
});

test("agent.mcp.deny alone leaves the specialists alone: it governs unattended tasks", () => {
  const read = agents({ deny: ["jenkins"] });
  assert.doesNotMatch(read("block-src-pricing"), /disallowedTools/);
});
