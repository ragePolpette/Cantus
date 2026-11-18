import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  analyze,
  assignDoc,
  buildScopePack,
  check,
  deleteGroup,
  docsForScope,
  exportClaudeAgents,
  renderContextPrompt,
  resolveScope,
  saveGroup,
  unassignDoc,
  validateModel,
  writeNotes,
  ProjectState,
  startMapServer,
} from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const flow = { id: "checkout-flow", name: "Checkout flow", blocks: ["src-checkout", "src-pricing"] };

function documented() {
  let model = saveGroup(shopModel(), flow);
  model = assignDoc(model, { path: "docs/conventions.md", common: true, description: "Code style and naming" });
  model = assignDoc(model, { path: "docs/pricing.md", blocks: ["src-pricing"] });
  model = assignDoc(model, { path: "docs/checkout-flow.md", groups: ["checkout-flow"] });
  model = assignDoc(model, { path: "docs/big-spec.md", blocks: ["src-pricing"], description: "Full pricing spec" });
  return model;
}

function project(model = documented()) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/conventions.md"), "# Conventions\n\nMoney is always in integer cents.\n");
  fs.writeFileSync(path.join(root, "docs/pricing.md"), "# Pricing\n\nVAT is applied after discounts, never before.\n");
  fs.writeFileSync(path.join(root, "docs/checkout-flow.md"), "# Checkout flow\n\nA cart is priced once, then frozen.\n");
  fs.writeFileSync(path.join(root, "docs/big-spec.md"), "# Spec\n\n" + "Long specification text. ".repeat(1000));
  return root;
}

test("documents are assigned to blocks, groups or everyone, merged by path, and validated", () => {
  const model = documented();
  assert.equal(model.docs.length, 4);
  const merged = assignDoc(model, { path: "./docs/pricing.md", blocks: ["src-checkout"], description: "Pricing rules" });
  assert.deepEqual(merged.docs.find((doc) => doc.path === "docs/pricing.md"), { path: "docs/pricing.md", blocks: ["src-pricing", "src-checkout"], description: "Pricing rules" });
  assert.throws(() => assignDoc(model, { path: "docs/x.md", blocks: ["src-nope"] }), /Unknown block\(s\) "src-nope"/);
  assert.throws(() => assignDoc(model, { path: "docs/x.md", groups: ["nope"] }), /Unknown group\(s\) "nope"/);
  assert.throws(() => assignDoc(model, { path: "../outside.md", common: true }), /must stay inside the project/);
  assert.throws(() => assignDoc(model, { path: "/etc/passwd", common: true }), /relative to the project root/);
  assert.throws(() => assignDoc(model, { path: "docs/x.md" }), /at least one block or group, or mark it common/);
  assert.deepEqual(validateModel({ ...model, docs: [...model.docs, { path: "docs/pricing.md", common: true }] }), ['document "docs/pricing.md" is listed twice']);

  const fewer = unassignDoc(merged, "docs/pricing.md", { blocks: ["src-pricing"] });
  assert.deepEqual(fewer.docs.find((doc) => doc.path === "docs/pricing.md").blocks, ["src-checkout"]);
  assert.equal(unassignDoc(fewer, "docs/pricing.md", { blocks: ["src-checkout"] }).docs.some((doc) => doc.path === "docs/pricing.md"), false, "no target left: removed");
  assert.equal(unassignDoc(model, "docs/conventions.md").docs.length, 3, "no target given: removed");
  assert.equal(unassignDoc(model, "docs/conventions.md", { common: true }).docs.length, 3);
  assert.throws(() => unassignDoc(model, "docs/none.md"), /No document "docs\/none\.md"/);
  assert.equal(deleteGroup(model, "checkout-flow").docs.some((doc) => doc.path === "docs/checkout-flow.md"), false, "deleting a group drops documents left without a target");

  const forGroup = docsForScope(model, flow);
  assert.deepEqual(forGroup.common.map((doc) => doc.path), ["docs/conventions.md"]);
  assert.deepEqual(forGroup.assigned.map((doc) => doc.path), ["docs/pricing.md", "docs/checkout-flow.md", "docs/big-spec.md"]);
  assert.deepEqual(docsForScope(model, { id: "src-web", blocks: ["src-web"] }).assigned, []);
});

test("briefings carry the team's documents next to the code's context", () => {
  const root = project();
  const model = documented();
  const analysis = analyze(root, { model, skipGit: true });
  const pricing = buildScopePack(analysis, resolveScope(analysis, model, { block: "src-pricing" }).scope, model);
  assert.deepEqual(pricing.docs.map((doc) => [doc.path, doc.common, doc.text !== undefined]), [
    ["docs/conventions.md", true, true],
    ["docs/pricing.md", false, true],
    ["docs/big-spec.md", false, false],
  ]);
  assert.ok(pricing.docTokens > 0 && pricing.docTokens < 200);

  const prompt = renderContextPrompt(pricing, { root, inlineSources: false });
  assert.match(prompt, /## Shared notes\n\nWritten by the team for every agent working on this project\.\n\n<doc path="docs\/conventions\.md" description="Code style and naming">\n# Conventions\n\nMoney is always in integer cents\.\n<\/doc>/);
  assert.match(prompt, /## Notes for this block\n\n.*\n\n<doc path="docs\/pricing\.md">\n# Pricing\n\nVAT is applied after discounts/);
  assert.match(prompt, /- `docs\/big-spec\.md` \(~6\.\dk tokens\) — Full pricing spec\. Too long to include here: read it before you start\./);
  assert.ok(prompt.indexOf("## Shared notes") < prompt.indexOf("## Neighbor contracts"), "documents come before the code's context");
  assert.match(prompt, /export declare function|## Neighbor contracts/, "the code-derived context is still there");

  const group = renderContextPrompt(buildScopePack(analysis, resolveScope(analysis, model, { group: "checkout-flow" }).scope, model), { root, inlineSources: false });
  assert.match(group, /## Notes for this group[\s\S]*docs\/pricing\.md[\s\S]*docs\/checkout-flow\.md/);
  const web = renderContextPrompt(buildScopePack(analysis, resolveScope(analysis, model, { block: "src-web" }).scope, model), { root, inlineSources: false });
  assert.match(web, /## Shared notes/);
  assert.doesNotMatch(web, /## Notes for this block/);

  const bigger = { ...model, agent: { docInlineTokens: 10_000 } };
  assert.ok(buildScopePack(analysis, { id: "src-pricing", name: "Pricing", blocks: ["src-pricing"] }, bigger).docs.every((doc) => doc.text !== undefined), "the inline budget is configurable");

  fs.rmSync(path.join(root, "docs/pricing.md"));
  const missing = renderContextPrompt(buildScopePack(analysis, { id: "src-pricing", name: "Pricing", blocks: ["src-pricing"] }, model), { root, inlineSources: false });
  assert.match(missing, /- `docs\/pricing\.md`: listed in the map, but the file is missing\./);
  const stale = check(analyze(root, { model, skipGit: true }), model).find((finding) => finding.kind === "stale-doc");
  assert.match(stale.message, /Document `docs\/pricing\.md`: the file does not exist/);
});

test("block notes and subagents point to the documents", () => {
  const root = project();
  const model = documented();
  const analysis = analyze(root, { model, skipGit: true });
  writeNotes(analysis, model);
  const notes = fs.readFileSync(path.join(root, "src/pricing/AGENTS.md"), "utf8");
  assert.match(notes, /- Read before working here: `docs\/pricing\.md`, `docs\/big-spec\.md` \(Full pricing spec\)\./);
  assert.match(notes, /- Shared notes for the whole project: `docs\/conventions\.md` \(Code style and naming\)\./);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /Shared notes for every agent[^\n]*\n\n- `docs\/conventions\.md` — Code style and naming/);
  exportClaudeAgents(analysis, model);
  assert.match(fs.readFileSync(path.join(root, ".claude/agents/block-src-pricing.md"), "utf8"), /The team's notes for you are part of that briefing: `docs\/pricing\.md`, `docs\/big-spec\.md`, `docs\/conventions\.md`/);
  assert.match(fs.readFileSync(path.join(root, ".claude/agents/group-checkout-flow.md"), "utf8"), /`docs\/checkout-flow\.md`/);
});

test("CLI: doc new, doc add, docs, context, doc remove", () => {
  const root = project(saveGroup(shopModel(), flow));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "-C", root], { encoding: "utf8" });
  const created = run("doc", "new", "--block", "src-orders", "--description", "Order states");
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /^Created docs\/blocks\/src-orders\.md\. Fill it in: it is a template\./);
  assert.match(fs.readFileSync(path.join(root, "docs/blocks/src-orders.md"), "utf8"), /^# Notes: Orders\n\n<!-- Notes for the agents working on Orders\./);
  assert.equal(run("doc", "add", "docs/conventions.md", "--common").status, 0);
  assert.match(run("docs").stdout, /- `docs\/blocks\/src-orders\.md` \(~\d+ tokens\) — blocks: src-orders — Order states\n- `docs\/conventions\.md` \(~\d+ tokens\) — common \(every agent\)/);
  assert.match(run("context", "src-orders").stdout, /## Shared notes[\s\S]*integer cents[\s\S]*## Notes for this block[\s\S]*# Notes: Orders/);
  assert.equal(run("doc", "add", "docs/none.md", "--block", "src-orders").status, 1, "a missing file is not assigned");
  assert.equal(run("doc", "add", "docs/conventions.md").status, 2, "who it is for is required");
  assert.equal(run("doc", "remove", "docs/conventions.md").status, 0);
  assert.doesNotMatch(run("docs").stdout, /conventions/);
  assert.ok(fs.existsSync(path.join(root, "docs/conventions.md")), "the file is kept");
});

test("MCP: assign_doc (with create), map, block_context, unassign_doc", async (t) => {
  const root = project(shopModel());
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--no-ui", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
  assert.match((await call("assign_doc", { path: "docs/conventions.md", common: true })).text, /^Assigned `docs\/conventions\.md`: common\./);
  assert.match((await call("assign_doc", { blocks: ["src-db"], create: true })).text, /^Created `docs\/blocks\/src-db\.md`: blocks src-db\. Fill it in/);
  assert.match((await call("map")).text, /## Team documents \(included in block_context briefings\)\n- `docs\/conventions\.md`/);
  assert.match((await call("block_context", { block: "src-db" })).text, /## Shared notes[\s\S]*## Notes for this block[\s\S]*# Notes: Database/);
  assert.equal((await call("assign_doc", { path: "docs/missing.md", blocks: ["src-db"] })).isError, true);
  assert.match((await call("unassign_doc", { path: "docs/blocks/src-db.md" })).text, /Documents now:\n- `docs\/conventions\.md`/);

  // A domain note, the way the lead (or a person) gives it: by path, under .cantus/domain.
  fs.mkdirSync(path.join(root, ".cantus/domain"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/domain/src-db.md"), "# Database\n\n## Pitfalls\n- Never open a second connection per request.\n");
  assert.match((await call("assign_doc", { path: ".cantus/domain/src-db.md", blocks: ["src-db"] })).text, /^Assigned `\.cantus\/domain\/src-db\.md`: blocks src-db\./);
  assert.match((await call("block_context", { block: "src-db" })).text, /## Notes for this block[\s\S]*Never open a second connection per request\./);
  assert.match((await call("unassign_doc", { path: ".cantus/domain/src-db.md" })).text, /Documents now:/);
  assert.ok(fs.existsSync(path.join(root, ".cantus/domain/src-db.md")), "taking a note from the map does not delete the file");
});

function request(server, { method = "GET", pathname, body, token = server.token }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: pathname, headers: { "x-cantus-token": token, "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: () => JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("the live map lists, assigns, creates, reads and edits documents, and nothing outside them", async (t) => {
  const root = project(saveGroup(shopModel(), flow));
  fs.writeFileSync(path.join(root, "src/pricing/AGENTS.md"), "generated notes");
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());

  fs.mkdirSync(path.join(root, "packages/ui"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages/ui/README.md"), "# UI package");
  fs.mkdirSync(path.join(root, "assets/plugins/x"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets/plugins/x/README.md"), "vendor");
  const model = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...model, analysis: { exclude: ["assets/plugins/**"] } }, null, 2));
  const files = (await request(server, { pathname: "/api/markdown-files" })).json();
  assert.deepEqual(files, ["docs/big-spec.md", "docs/checkout-flow.md", "docs/conventions.md", "docs/pricing.md", "packages/ui/README.md"], "block notes and excluded paths are not offered; a monorepo's packages are");
  fs.rmSync(path.join(root, "packages/ui"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages/Newtonsoft.Json.13.0.1"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages/Newtonsoft.Json.13.0.1/Newtonsoft.Json.13.0.1.nupkg"), "");
  fs.writeFileSync(path.join(root, "packages/Newtonsoft.Json.13.0.1/LICENSE.md"), "MIT");
  assert.ok(!(await request(server, { pathname: "/api/markdown-files" })).json().some((file) => file.startsWith("packages/")), "NuGet packages are not offered");
  assert.equal((await request(server, { method: "POST", pathname: "/api/docs", body: { path: "docs/pricing.md", blocks: ["src-pricing"] } })).status, 200);
  assert.deepEqual((await request(server, { method: "POST", pathname: "/api/docs", body: { groups: ["checkout-flow"], create: true } })).json(), { path: "docs/groups/checkout-flow.md", created: true });
  assert.equal((await request(server, { method: "POST", pathname: "/api/docs", body: { path: "docs/conventions.md", common: true } })).status, 200);

  const view = (await request(server, { pathname: "/api/view" })).json();
  assert.deepEqual(view.docs.map((doc) => [doc.path, doc.exists, doc.common ?? false]), [["docs/pricing.md", true, false], ["docs/groups/checkout-flow.md", true, false], ["docs/conventions.md", true, true]]);
  const pricing = view.blocks.find((block) => block.id === "src-pricing");
  const web = view.blocks.find((block) => block.id === "src-web");
  assert.ok(pricing.contextTokens > 0 && web.contextTokens > 0);

  const content = await request(server, { pathname: "/api/docs/content?path=docs/pricing.md" });
  assert.match(content.json().text, /VAT is applied after discounts/);
  assert.equal((await request(server, { method: "PUT", pathname: "/api/docs/content?path=docs/pricing.md", body: { text: "# Pricing\n\nRound half up.\n" } })).status, 200);
  assert.equal(fs.readFileSync(path.join(root, "docs/pricing.md"), "utf8"), "# Pricing\n\nRound half up.\n");

  assert.equal((await request(server, { method: "PUT", pathname: "/api/docs/content?path=src/pricing/index.ts", body: { text: "x" } })).status, 404, "only documents of the map are written");
  assert.equal((await request(server, { method: "PUT", pathname: "/api/docs/content?path=../escape.md", body: { text: "x" } })).status, 400);
  assert.equal((await request(server, { pathname: "/api/docs/content?path=docs/pricing.md", token: "wrong" })).status, 403);
  assert.equal((await request(server, { method: "POST", pathname: "/api/docs", body: { path: "docs/none.md", blocks: ["src-web"] } })).status, 400);

  assert.equal((await request(server, { method: "POST", pathname: "/api/docs/unassign", body: { path: "docs/conventions.md", common: true } })).status, 200);
  assert.equal((await request(server, { pathname: "/api/view" })).json().docs.some((doc) => doc.path === "docs/conventions.md"), false);
  assert.ok(fs.existsSync(path.join(root, "docs/conventions.md")));
});

test("a domain note written by hand is offered by the map, assigned from there or from the command line, read, edited and carried by the briefing", async (t) => {
  const root = project(saveGroup(shopModel(), flow));
  fs.mkdirSync(path.join(root, ".cantus/domain"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/domain/src-pricing.md"), "# Pricing\n\n## Invariants\n- VAT is applied after discounts (src/pricing/index.ts).\n");
  fs.writeFileSync(path.join(root, ".cantus/domain/src-orders.md"), "# Orders\n\n## Pitfalls\n- An empty cart is rejected before pricing.\n");
  fs.writeFileSync(path.join(root, ".cantus/domain/notes.txt"), "not markdown");
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());

  const files = (await request(server, { pathname: "/api/markdown-files" })).json();
  assert.ok(files.includes(".cantus/domain/src-pricing.md") && files.includes(".cantus/domain/src-orders.md"), "the notes are offered next to the other documents");
  assert.ok(!files.some((file) => file.startsWith(".cantus/") && !file.startsWith(".cantus/domain/")), "nothing else of .cantus");
  assert.ok(!files.includes(".cantus/domain/notes.txt"));

  // From the map's panel (the same route the page uses).
  assert.equal((await request(server, { method: "POST", pathname: "/api/docs", body: { path: ".cantus/domain/src-pricing.md", blocks: ["src-pricing"] } })).status, 200);
  const read = (await request(server, { pathname: "/api/docs/content?path=.cantus%2Fdomain%2Fsrc-pricing.md" })).json();
  assert.match(read.text, /VAT is applied after discounts/);
  assert.equal((await request(server, { method: "PUT", pathname: "/api/docs/content?path=.cantus%2Fdomain%2Fsrc-pricing.md", body: { text: read.text + "- Rounding happens once, at the end.\n" } })).status, 200);

  // From the command line.
  const added = spawnSync(process.execPath, [cli, "doc", "add", ".cantus/domain/src-orders.md", "--block", "src-orders", "-C", root], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);

  const pricing = spawnSync(process.execPath, [cli, "context", "src-pricing", "-C", root], { encoding: "utf8" }).stdout;
  assert.match(pricing, /Notes for this block[\s\S]*<doc path="\.cantus\/domain\/src-pricing\.md">[\s\S]*Rounding happens once, at the end\./);
  assert.doesNotMatch(pricing, /An empty cart is rejected/, "another block's note is not in this briefing");
  const orders = spawnSync(process.execPath, [cli, "context", "src-orders", "-C", root], { encoding: "utf8" }).stdout;
  assert.match(orders, /An empty cart is rejected before pricing/);
  // Regenerating the blocks' own notes leaves them (and the index) alone.
  assert.equal(spawnSync(process.execPath, [cli, "notes", "-C", root], { encoding: "utf8" }).status, 0);
  assert.match(fs.readFileSync(path.join(root, ".cantus/domain/src-orders.md"), "utf8"), /An empty cart is rejected/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8")).docs.map((doc) => doc.path).sort(), [".cantus/domain/src-orders.md", ".cantus/domain/src-pricing.md"]);
});
