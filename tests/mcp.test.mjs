import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProjectState, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/** Starts `cantus mcp` the way a coding CLI does, over stdio. */
async function connect(t, root) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
  return { client, call };
}

function mappedShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  const model = shopModel();
  model.blocks.find((block) => block.id === "src-orders").description = "Creates and stores orders.";
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  return root;
}

test("the MCP server exposes the map tools with instructions", async (t) => {
  const { client } = await connect(t, mappedShop());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["add_block", "add_dependency", "apply_design", "assign_doc", "block_context", "boundary_candidates", "callers", "check", "delete_group", "diff", "dismiss_suggestion", "edit_block", "find_api", "impact", "map", "merge_block", "move_to_block", "open_map", "pending_requests", "plan_propose", "plan_status", "remove_block", "remove_dependency", "request_accept", "request_done", "review_changes", "save_group", "set_external_access", "set_layers", "sketch_map", "snapshot", "specialist_prompt", "split_block", "symbol_context", "task_cancel", "task_retry", "trace", "unassign_doc", "update_map", "update_notes", "worktree_done", "worktree_prepare", "worktrees"]);
  assert.equal(tools.find((tool) => tool.name === "map").annotations.readOnlyHint, true);
  assert.match(client.getInstructions(), /The map is a guide, not a rule/);
  assert.match((await client.callTool({ name: "open_map", arguments: {} })).content[0].text, /^The live map is at http:\/\/127\.0\.0\.1:\d+\//);
});

test("a worktree setup requested over MCP is visible from another live map and can be cancelled or attached", async (t) => {
  const root = mappedShop();
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=Cantus", "-c", "user.email=cantus@example.test", "commit", "-m", "Fixture");
  const file = path.join(root, ".cantus/model.json");
  const model = JSON.parse(fs.readFileSync(file, "utf8"));
  const script = path.join(root, "a-long-worktree-script-name-" + "x".repeat(120) + ".mjs");
  fs.writeFileSync(script, 'throw new Error("The automatic script should never run in this test");');
  model.agent = { worktree: { base: "main", script, scriptArgs: ["{branch}", "{path}"] } };
  fs.writeFileSync(file, JSON.stringify(model));

  const other = await startMapServer(new ProjectState(root), { port: 0, warm: false });
  t.after(() => other.close());
  const { call } = await connect(t, root);
  const otherRequests = async () => {
    const response = await fetch(new URL("api/worktree-requests", other.url), { headers: { "x-cantus-token": other.token } });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await otherRequests(), []);

  const first = await call("worktree_prepare", { block: "src-orders", branch: "test/cancel-worktree", prompt: "Prepare " + "details ".repeat(400) });
  assert.equal(first.isError, false);
  assert.match(first.text, /waiting/);
  const firstId = /^([a-f0-9]+) ·/.exec(first.text)[1];
  const [request] = await otherRequests();
  assert.equal(request.id, firstId);
  assert.equal(request.branch, "test/cancel-worktree");
  assert.ok(!request.url.startsWith(other.url));
  assert.ok(first.text.includes(script), "the answer has the commands that wait for the yes");
  assert.ok(first.text.includes("Planned worktree folder:"));
  assert.match(first.text, /Worktrees column/);
  assert.match((await call("task_cancel", { id: firstId })).text, /stopped/);
  assert.deepEqual(await otherRequests(), []);
  assert.equal(git("branch", "--list", "test/cancel-worktree"), "");

  const second = await call("worktree_prepare", { block: "src-orders", branch: "test/attach-worktree", prompt: "Continue in this worktree" });
  assert.equal(second.isError, false);
  const [pending] = await otherRequests();
  const map = new URL(pending.url);
  const token = /"token":"([a-f0-9]+)"/.exec(await (await fetch(map)).text())[1];
  const endpoint = new URL(`api/tasks/${pending.id}`, map);
  const headers = { "x-cantus-token": token };
  const attach = () => fetch(`${endpoint}/attach-worktree`, { method: "POST", headers });
  assert.equal((await attach()).status, 400);
  const folder = path.join(root, ".cantus", "worktrees", "manual");
  git("worktree", "add", "-b", "test/attach-worktree", folder, "main");
  const waiting = await (await fetch(endpoint, { headers })).json();
  const approval = await fetch(`${endpoint}/approvals/${waiting.approvals[0].id}`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ allow: true }),
  });
  assert.equal(approval.status, 400, "approval must not rerun the script for a manually created branch");
  assert.equal((await attach()).status, 200);
  let task;
  for (let i = 0; i < 40; i++) {
    task = await (await fetch(endpoint, { headers })).json();
    if (task.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(task.status, "prepared", task.error);
  assert.equal(task.session.folder, fs.realpathSync.native(folder));
  assert.match(fs.readFileSync(path.join(folder, task.session.promptFile), "utf8"), /Continue in this worktree/);
  assert.deepEqual(await otherRequests(), []);
});

test("specialist_prompt gives a specialist's instructions without the agent file, for a session that cannot load it", async (t) => {
  const { call } = await connect(t, mappedShop());
  const block = await call("specialist_prompt", { id: "block-src-orders" });
  assert.match(block.text, /^Pass this as the prompt of a general-purpose subagent, followed by the task:\n\nYou are the specialist of the \*\*Orders\*\* block \(`src-orders`/);
  assert.doesNotMatch(block.text, /^name: |Generated by `cantus agents`/m, "no frontmatter, no marker");
  assert.match((await call("specialist_prompt", { id: "src-orders" })).text, /specialist of the \*\*Orders\*\* block/, "the prefix is optional");
  assert.match((await call("specialist_prompt", { id: "cantus-scope" })).text, /Your scope is the set of blocks named in the task/);
  const missing = await call("specialist_prompt", { id: "nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No block, group or scope agent "nope"/);
});

test("map, block_context, find_api, callers and check answer from the code", async (t) => {
  const { call } = await connect(t, mappedShop());

  const map = await call("map");
  assert.match(map.text, /## Orders \(`src-orders`, domain\)\nCreates and stores orders\./);
  assert.match(map.text, /Used by: src-checkout/);

  const byBlock = await call("block_context", { block: "src-orders" });
  assert.match(byBlock.text, /# Block: Orders \(`src-orders`\)/);
  assert.match(byBlock.text, /## Callers of your API/);
  assert.match(byBlock.text, /`src\/checkout\/index\.ts:11` \(src-checkout\): `return createOrder\(cart\.id, total\);`/);
  assert.doesNotMatch(byBlock.text, /secretImplementationDetail/, "sources are not inlined by default");
  const byFile = await call("block_context", { file: "src/orders/index.ts", include_sources: true });
  assert.match(byFile.text, /ORDERS_INTERNAL_42/);
  assert.equal((await call("block_context", { block: "nope" })).isError, true);

  assert.match((await call("find_api", { query: "discount", from_block: "src-checkout" })).text, /\[already a dependency: src-pricing\]/);
  assert.match((await call("callers", { symbol: "createOrder" })).text, /1 call site\(s\):[\s\S]*src\/checkout\/index\.ts:11/);
  assert.equal((await call("callers")).isError, true);

  const checked = await call("check");
  assert.match(checked.text, /\[info\] Not on the map yet: Web imports Database/);
  assert.match((await call("check", { strict: true })).text, /\[error\] Web imports Database, which the map does not allow/);
});

test("the server sees code changes without restarting", async (t) => {
  const root = mappedShop();
  const { call } = await connect(t, root);
  assert.match((await call("find_api", { query: "coupon" })).text, /No exported symbol matches/);
  fs.writeFileSync(path.join(root, "src/pricing/coupon.ts"), "/** Discount for a coupon code. */\nexport function coupon(code: string): number {\n  return code.length;\n}\n");
  assert.match((await call("find_api", { query: "coupon" })).text, /\[src-pricing\] src\/pricing\/coupon\.ts: function coupon\(code: string\): number; — Discount for a coupon code\./);
});

test("update_map and update_notes write the map and the block notes", async (t) => {
  const root = mappedShop();
  const { call } = await connect(t, root);
  const updated = await call("update_map");
  assert.equal(updated.text, "New dependencies: src-web → src-db.");
  const saved = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
  assert.equal(saved.blocks.find((block) => block.id === "src-orders").description, "Creates and stores orders.", "human text is kept");
  assert.equal((await call("update_map")).text, "The map already matches the code.");
  assert.doesNotMatch((await call("check")).text, /Not on the map yet/);

  const notes = await call("update_notes");
  assert.match(notes.text, /Updated: .*src\/orders\/AGENTS\.md/);
  assert.match(fs.readFileSync(path.join(root, "src/orders/AGENTS.md"), "utf8"), /Most called from other blocks: `createOrder` \(1\)/);
});

test("apply_design scaffolds a new project and refuses an existing map", async (t) => {
  const root = copyFixture("mono");
  fs.rmSync(path.join(root, "packages"), { recursive: true });
  const { call } = await connect(t, root);
  const design = {
    name: "notes",
    blocks: [
      { name: "API", layer: "interface", path: "src/api", description: "HTTP routes", contract: 'import type { Note } from "../notes/index.js";\nexport declare function listNotes(): Promise<Note[]>;' },
      { name: "Notes", layer: "domain", path: "src/notes", description: "Note rules", contract: "export interface Note { id: string; text: string }" },
    ],
    dependencies: [{ from: "src/api", to: "src/notes" }],
  };
  const result = await call("apply_design", { design });
  assert.match(result.text, /Created the map with 2 blocks and 2 contract file\(s\): src\/api\/index\.ts, src\/notes\/index\.ts\./);
  assert.match((await call("map")).text, /## API \(`src-api`, interface\)/);
  assert.equal((await call("apply_design", { design })).isError, true);

  // A Python project: no TypeScript contracts, the map is sketched instead.
  const python = copyFixture("mono");
  fs.rmSync(path.join(python, "packages"), { recursive: true });
  fs.rmSync(path.join(python, "package.json"), { force: true });
  fs.writeFileSync(path.join(python, "pyproject.toml"), "[project]\nname = \"motore\"\n");
  const other = await connect(t, python);
  const refused = await other.call("apply_design", { design });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /has pyproject\.toml: a design writes TypeScript contracts.*Sketch the map instead/);
  assert.equal(fs.existsSync(path.join(python, "src/api/index.ts")), false);
});

test("sketch_map adds planned layers, blocks and arrows, keeping the map", async (t) => {
  const root = mappedShop();
  const { call } = await connect(t, root);
  const result = await call("sketch_map", {
    draft: {
      layers: ["edge"],
      blocks: [{ name: "Wishlist", layer: "domain", folder: "src/wishlist", description: "Saved products." }, { name: "Orders again", layer: "domain", folder: "src/orders", description: "ignored" }],
      dependencies: [{ from: "src/checkout", to: "src/wishlist" }],
    },
  });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /1 block\(s\) \(src-wishlist\), 1 arrow\(s\), layers edge/);
  const model = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
  assert.deepEqual(model.layers, ["interface", "application", "domain", "infrastructure", "edge"]);
  assert.equal(model.blocks.find((block) => block.id === "src-orders").description, "Creates and stores orders.", "blocks on the map are kept");
  assert.ok(model.dependencies.some((dep) => dep.from === "src-checkout" && dep.to === "src-wishlist"));
});

test("read tools say what the answer reflects: analysis time, commit, uncommitted files", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const root = mappedShop();
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  const commit = git("rev-parse", "--short", "HEAD").toString().trim();
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "// wip\n");
  const { client, call } = await connect(t, root);
  const result = await client.callTool({ name: "map", arguments: {} });
  const text = result.content.map((part) => part.text).join("\n");
  assert.match(text, new RegExp(`\\n\\n\\(Cantus: analysis of \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC, commit ${commit}, 1 uncommitted file\\(s\\) included\\)$`));
  assert.equal(result._meta.cantus.commit, commit);
  assert.equal(result._meta.cantus.uncommittedFiles, 1);
  assert.ok(Date.parse(result._meta.cantus.analyzedAt) > 0);
  assert.doesNotMatch((await call("update_notes")).text, /\(Cantus: analysis of/, "tools that write do not carry it");
});

test("find_api searches one block's API, or lists it", async (t) => {
  const { call } = await connect(t, mappedShop());
  const listed = await call("find_api", { block: "src-pricing" });
  assert.match(listed.text, /^2 export\(s\) of `src-pricing`:/);
  assert.match(listed.text, /quote/);
  assert.match(listed.text, /discount/);
  const searched = (await call("find_api", { block: "src-orders", query: "price quote" })).text;
  assert.doesNotMatch(searched, /src-pricing/, "other blocks are left out");
  const unknown = await call("find_api", { block: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No block "nope"\. Blocks: src-web, /);
  assert.match((await call("find_api", { query: "toast" })).text, /^No exported symbol matches "toast"/, "a word part shorter than three letters does not match");
  assert.equal((await call("find_api", {})).isError, true);
});

test("read-only MCP pages are structured, bounded and shared with the CLI", async (t) => {
  const root = mappedShop();
  const client = new Client({ name: "standard-client", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root, "--read-only"], stderr: "pipe" }));
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes("snapshot"));
  for (const name of ["update_map", "worktree_prepare", "open_map", "pending_requests"]) assert.ok(!names.includes(name), name);
  assert.equal(client.getServerCapabilities()?.experimental?.["claude/channel"], undefined);
  const first = (await client.callTool({ name: "snapshot", arguments: { kind: "api", limit: 1 } })).structuredContent;
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.items.length, 1);
  const next = (await client.callTool({ name: "snapshot", arguments: { kind: "api", limit: 1, offset: first.page.nextOffset } })).structuredContent;
  assert.notDeepEqual(first.items, next.items);
  assert.equal(first.analysis.fingerprint, next.analysis.fingerprint);
  const result = execFileSync(process.execPath, [cli, "snapshot", "-C", root, "--kind", "api", "--limit", "1"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(result).items, first.items);
  assert.equal((await client.callTool({ name: "snapshot", arguments: { limit: 101 } })).isError, true);
});

test("symbol_context in read-only MCP lists a definition and callers without a full block briefing", async (t) => {
  const root = mappedShop();
  const client = new Client({ name: "symbol-context-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root, "--read-only"], stderr: "pipe" }));
  t.after(() => client.close());
  const result = await client.callTool({ name: "symbol_context", arguments: { symbol: "createOrder", file: "src/orders/index.ts" } });
  assert.equal(result.isError, undefined);
  const answer = result.content.map((part) => part.text).join("\n");
  assert.match(answer, /Definition: src\/orders\/index.ts/);
  assert.match(answer, /src\/checkout\/index.ts:\d+ \(reference\)/);
  assert.match(answer, /Related tests/);
  assert.match(answer, /Use block_context/);
  assert.doesNotMatch(answer, /This briefing:|Other blocks/);
});
