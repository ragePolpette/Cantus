import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  analyze,
  buildScopePack,
  buildViewData,
  check,
  deleteGroup,
  exportClaudeAgents,
  handleHook,
  renderContextPrompt,
  resolveScope,
  saveGroup,
  writeNotes,
  writeProjectIndex,
} from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const checkoutFlow = { id: "checkout-flow", name: "Checkout flow", blocks: ["src-checkout", "src-pricing", "src-orders"], description: "Everything between cart and order." };

function groupedModel() {
  return saveGroup(shopModel(), checkoutFlow);
}

function mappedShop(model = groupedModel()) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  return root;
}

test("groups are saved, replaced and deleted with validation", () => {
  const model = groupedModel();
  assert.deepEqual(model.groups.map((group) => group.id), ["checkout-flow"]);
  assert.throws(() => saveGroup(model, { id: "x", name: "X", blocks: ["src-nope"] }), /Unknown block\(s\) "src-nope"/);
  assert.throws(() => saveGroup(model, { id: "Bad Id", name: "X", blocks: ["src-web"] }), /must be kebab-case/);
  const replaced = saveGroup(model, { ...checkoutFlow, blocks: ["src-checkout", "src-checkout"] });
  assert.deepEqual(replaced.groups, [{ ...checkoutFlow, blocks: ["src-checkout"] }], "same id replaces; duplicates collapse");
  assert.equal(deleteGroup(model, "checkout-flow").groups.length, 0);
  assert.throws(() => deleteGroup(model, "nope"), /No group "nope"/);
});

test("a group is briefed as one scope: internal dependencies, outside neighbors and callers", () => {
  const model = groupedModel();
  const analysis = analyze(copyFixture("shop"), { model, skipGit: true });
  const pack = buildScopePack(analysis, checkoutFlow, model, check(analysis, model));

  assert.equal(pack.block.id, "checkout-flow");
  assert.deepEqual(pack.block.include, ["src/checkout", "src/pricing", "src/orders"]);
  assert.deepEqual(pack.group.internal.map((dep) => `${dep.from}->${dep.to}`), ["src-checkout->src-orders", "src-checkout->src-pricing"]);
  assert.deepEqual(pack.neighbors.map((neighbor) => neighbor.block.id), ["src-db", "src-payments"]);
  assert.deepEqual(pack.dependents.map((dependent) => dependent.block.id), ["src-web"]);
  assert.deepEqual(pack.callers.map((site) => `${site.block}:${site.symbol}`), ["src-web:placeOrder"], "calls inside the group are not callers");
  assert.deepEqual(pack.files.map((file) => file.path), ["src/checkout/cart.ts", "src/checkout/index.ts", "src/orders/index.ts", "src/pricing/index.ts"]);

  const prompt = renderContextPrompt(pack, { root: analysis.root, inlineSources: false });
  assert.match(prompt, /^# Group: Checkout flow \(`checkout-flow`\)/);
  assert.match(prompt, /## Blocks in this group/);
  assert.match(prompt, /- `src-checkout` uses `src-orders`: `Order`, `createOrder`/);
  assert.match(prompt, /## Working in this group/);
  assert.match(prompt, /### Database \(`src-db`/);
});

test("scopes resolve from a block, a file, a saved group, or an ad-hoc list", () => {
  const model = groupedModel();
  const analysis = analyze(copyFixture("shop"), { model, skipGit: true });
  assert.deepEqual(resolveScope(analysis, model, { block: "src-web" }).scope.blocks, ["src-web"]);
  assert.deepEqual(resolveScope(analysis, model, { file: "src/db/client.ts" }).scope.blocks, ["src-db"]);
  assert.deepEqual(resolveScope(analysis, model, { group: "checkout-flow" }).scope.blocks, checkoutFlow.blocks);
  assert.equal(resolveScope(analysis, model, { blocks: ["src-web", "src-db"] }).scope.id, "scope-src-web+src-db");
  assert.equal(resolveScope(analysis, model, { blocks: ["src-web"] }).scope.id, "src-web", "a list of one is that block");
  assert.throws(() => resolveScope(analysis, model, { group: "nope" }), /No group "nope". Saved groups: checkout-flow/);
  assert.throws(() => resolveScope(analysis, model, { blocks: ["src-web", "src-x"] }), /Unknown block "src-x"/);

  const stale = { ...model, blocks: model.blocks.filter((block) => block.id !== "src-orders"), dependencies: model.dependencies.filter((dep) => dep.to !== "src-orders" && dep.from !== "src-orders") };
  const staleAnalysis = analyze(copyFixture("shop"), { model: stale, skipGit: true });
  const resolved = resolveScope(staleAnalysis, stale, { group: "checkout-flow" });
  assert.deepEqual(resolved.scope.blocks, ["src-checkout", "src-pricing"]);
  assert.deepEqual(resolved.notes, ['Group "checkout-flow" lists blocks that no longer exist: src-orders.']);
  const finding = check(staleAnalysis, stale).find((candidate) => candidate.kind === "stale-group");
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /Group Checkout flow \(`checkout-flow`\) lists blocks that no longer exist: src-orders/);
});

test("MCP: save_group, block_context by group or blocks, map, delete_group", async (t) => {
  const root = mappedShop(shopModel());
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };

  assert.match((await call("save_group", checkoutFlow)).text, /Saved group Checkout flow \(`checkout-flow`\): src-checkout, src-pricing, src-orders\./);
  assert.match((await call("map")).text, /## Groups \(scopes for block_context\)\n- Checkout flow \(`checkout-flow`\): src-checkout, src-pricing, src-orders — Everything between cart and order\./);
  assert.match((await call("block_context", { group: "checkout-flow" })).text, /^# Group: Checkout flow/);
  assert.match((await call("block_context", { blocks: ["src-web", "src-db"] })).text, /^# Group: Scope: src-web, src-db/);
  assert.equal((await call("save_group", { id: "x", name: "X", blocks: ["src-nope"] })).isError, true);
  assert.match((await call("delete_group", { id: "checkout-flow" })).text, /Deleted group/);
  assert.equal((await call("block_context", { group: "checkout-flow" })).isError, true);
});

test("subagents for saved groups and for ad-hoc scopes; removed with the group", () => {
  const root = mappedShop();
  const model = groupedModel();
  const result = exportClaudeAgents(analyze(root, { model, skipGit: true }), model);
  assert.ok(result.written.includes(".claude/agents/group-checkout-flow.md"));
  assert.ok(result.written.includes(".claude/agents/cantus-scope.md"));
  const agent = fs.readFileSync(path.join(root, ".claude/agents/group-checkout-flow.md"), "utf8");
  assert.match(agent, /^---\nname: group-checkout-flow\ndescription: "Specialist of the Checkout flow group of blocks \(src-checkout, src-pricing, src-orders\): Everything between cart and order\. Delegate/);
  assert.match(agent, /`block_context` with group `checkout-flow`/);
  assert.match(fs.readFileSync(path.join(root, ".claude/agents/cantus-scope.md"), "utf8"), /`block_context` with `blocks` set to those block ids/);

  const without = deleteGroup(model, "checkout-flow");
  assert.deepEqual(exportClaudeAgents(analyze(root, { model: without, skipGit: true }), without).removed, [".claude/agents/group-checkout-flow.md"]);
});

test("hooks see a group specialist's whole scope", () => {
  const root = copyFixture("shop");
  const model = groupedModel();
  writeProjectIndex(root, analyze(root, { model, skipGit: true }), model);
  const edit = (file) => ({ cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, file) }, agent_type: "group-checkout-flow" });

  assert.equal(handleHook("pre-edit", edit("src/orders/index.ts"), root), undefined, "inside the group, and its only caller is inside too");
  const outside = handleHook("pre-edit", edit("src/db/client.ts"), root).hookSpecificOutput.additionalContext;
  assert.match(outside, /src\/db\/client\.ts belongs to block `src-db` \(Database\), outside the group `checkout-flow`/);
  assert.match(outside, /- db ← src\/orders\/index\.ts:10, src\/web\/checkout-page\.ts:6/);
  assert.match(handleHook("pre-edit", edit("src/checkout/index.ts"), root).hookSpecificOutput.additionalContext, /- placeOrder ← src\/web\/checkout-page\.ts:5/);
});

test("CLI: group save, groups, context --group, group delete", () => {
  const root = mappedShop(shopModel());
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "-C", root], { encoding: "utf8" });
  assert.match(run("group", "save", "checkout-flow", "src-checkout", "src-pricing", "--name", "Checkout flow").stdout, /Saved group Checkout flow \(checkout-flow\): src-checkout, src-pricing\./);
  assert.match(run("groups").stdout, /checkout-flow\s+src-checkout, src-pricing\s+\(Checkout flow\)/);
  assert.match(run("context", "--group", "checkout-flow").stdout, /^# Group: Checkout flow/);
  assert.match(run("context", "src-web,src-db").stdout, /^# Group: Scope: src-web, src-db/);
  assert.equal(run("group", "save", "x", "src-nope").status, 1);
  assert.match(run("group", "delete", "checkout-flow").stdout, /Deleted group checkout-flow\./);
  assert.match(run("groups").stdout, /No saved groups/);
});

test("the view and the root notes list the groups", () => {
  const root = mappedShop();
  const model = groupedModel();
  const analysis = analyze(root, { model, skipGit: true });
  const [group] = buildViewData(analysis, model, check(analysis, model)).groups;
  assert.deepEqual(group.blocks, checkoutFlow.blocks);
  assert.deepEqual(group.neighbors, ["src-db", "src-payments"]);
  assert.equal(group.callers, 1);
  assert.ok(group.contextTokens > 0);
  writeNotes(analysis, model);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /- `checkout-flow` \(Checkout flow\): src-checkout, src-pricing, src-orders/);
});
