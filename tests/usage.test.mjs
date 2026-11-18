import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import { ProjectState, USAGE_FILE, analyze, handleHook, readUsage, recordUsage, renderStats, reportRead, startMapServer, summarizeUsage, writeProjectIndex } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function mappedShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  return root;
}

test("events are appended to .cantus/cache/usage.jsonl, and CANTUS_STATS=off records nothing", (t) => {
  const root = mappedShop();
  recordUsage(root, { kind: "tool", tool: "map", ok: true, tokens: 300 });
  const events = readUsage(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool");
  assert.match(events[0].t, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(readUsage(root, new Date(Date.now() + 60_000)), [], "since");
  process.env.CANTUS_STATS = "off";
  t.after(() => delete process.env.CANTUS_STATS);
  recordUsage(root, { kind: "tool", tool: "check", ok: true, tokens: 1 });
  assert.equal(readUsage(root).length, 1);
});

test("a log past 2 MB moves to usage.jsonl.1 and both are read", () => {
  const root = mappedShop();
  const file = path.join(root, USAGE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (JSON.stringify({ t: "2026-10-01T00:00:00.000Z", kind: "tool", tool: "old", ok: true, tokens: 1, pad: "x".repeat(1000) }) + "\n").repeat(2200));
  recordUsage(root, { kind: "tool", tool: "new", ok: true, tokens: 1 });
  assert.ok(fs.existsSync(`${file}.1`));
  const events = readUsage(root);
  assert.equal(events.length, 2201);
  assert.equal(events.at(-1).tool, "new");
});

test("the summary counts briefings, searches, edits and reads per block and says where context is missing", () => {
  const root = mappedShop();
  const blocks = shopModel().blocks;
  const at = (event) => ({ t: "2026-10-28T10:00:00.000Z", ...event });
  const events = [
    at({ kind: "briefing", scope: ["src-checkout"], tokens: 6000, neighbors: 9000, own: 2000, mode: "cut" }),
    at({ kind: "briefing", scope: ["src-pricing"], tokens: 5000, neighbors: 9000, own: 2000, mode: "tiered" }),
    at({ kind: "briefing", scope: ["src-checkout"], tokens: 20000, neighbors: 30000, own: 2000, mode: "compact" }),
    at({ kind: "tool", tool: "block_context", ok: true, tokens: 6000 }),
    at({ kind: "tool", tool: "find_api", ok: false, tokens: 10 }),
    at({ kind: "search", query: "Sconto", hits: 0 }),
    at({ kind: "search", query: "sconto ", hits: 0 }),
    at({ kind: "search", query: "price", hits: 4 }),
    ...Array.from({ length: 3 }, () => at({ kind: "read", file: "src/pricing/index.ts", block: "src-pricing", agent: "block-src-checkout" })),
    at({ kind: "read", file: "src/checkout/index.ts", block: "src-checkout", agent: "block-src-checkout" }),
    at({ kind: "read", file: "src/pricing/index.ts", block: "src-pricing" }),
    ...Array.from({ length: 3 }, () => at({ kind: "edit", phase: "before", file: "src/orders/index.ts", block: "src-orders", agent: "block-src-checkout", outside: true, note: 120 })),
    at({ kind: "edit", phase: "after", file: "src/orders/index.ts", block: "src-orders", agent: "block-src-checkout", broken: 2 }),
    ...Array.from({ length: 3 }, () => at({ kind: "edit", phase: "before", file: "src/web/page.ts", block: "src-web" })),
  ];
  const stats = summarizeUsage(root, events, blocks);
  const checkout = stats.blocks.find((block) => block.id === "src-checkout");
  assert.deepEqual({ ...checkout.briefingTokens, n: checkout.briefings, shortened: checkout.shortened }, { average: 13000, max: 20000, n: 2, shortened: 2 });
  assert.equal(stats.blocks.find((block) => block.id === "src-pricing").shortened, 0, "the exports used instead of whole files is the normal form, not a cut");
  assert.deepEqual(checkout.outsideReads, [{ file: "src/pricing/index.ts", ownedBy: "src-pricing", count: 3 }], "the specialist's own block and the main session's reads are not counted");
  assert.equal(checkout.outsideEdits, 3, "an outside edit counts against the block whose specialist made it");
  assert.equal(stats.blocks.find((block) => block.id === "src-orders").broken, 2);
  assert.equal(stats.blocks.find((block) => block.id === "src-orders").notes, 3);
  assert.deepEqual(stats.misses, [{ query: "sconto", count: 2 }]);
  assert.deepEqual(stats.tools.find_api ?? stats.tools["find_api"], { calls: 1, errors: 1, tokens: 10 });
  const text = stats.suggestions.join("\n");
  assert.match(text, /Checkout \(`src-checkout`\): its specialists opened `src\/pricing\/index\.ts` \(block `src-pricing`\) 3 times/);
  assert.match(text, /Checkout \(`src-checkout`\): 3 edits by its specialists outside the block/);
  assert.match(text, /every briefing was shortened \(up to 20000 tokens\)/);
  assert.match(text, /"sconto" found nothing 2 times/);
  assert.match(text, /Web \(`src-web`\): 3 edits and no briefing asked for/);
  const printed = renderStats(stats);
  assert.match(printed, /Where to add context\n  - /);
  assert.match(printed, /src-checkout → src\/pricing\/index\.ts \(src-pricing\) ×3/);
});

test("map tasks are counted from their records: cost by model, delegations, asks outside the scope", () => {
  const root = mappedShop();
  const runs = path.join(root, ".cantus/runs");
  fs.mkdirSync(runs, { recursive: true });
  const task = (id, extra) => fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({ id, startedAt: "2026-10-28T10:00:00.000Z", scope: { blocks: ["src-orders"] }, delegations: [], approvals: [], ...extra }));
  task("a", { model: "haiku", costUsd: 0.05, approvals: [{ outsideScope: true }, { outsideScope: true }, { outsideScope: true }] });
  task("b", { model: "opus", costUsd: 0.6, delegations: [{}, {}] });
  task("c", { costUsd: 0.1 });
  fs.writeFileSync(path.join(runs, "broken.json"), "{");
  const stats = summarizeUsage(root, [], shopModel().blocks);
  assert.equal(stats.tasks.count, 3);
  assert.equal(Math.round(stats.tasks.costUsd * 100), 75);
  assert.deepEqual(Object.keys(stats.tasks.byModel).sort(), ["default", "haiku", "opus"]);
  assert.equal(stats.tasks.delegations, 2);
  assert.match(stats.suggestions.join("\n"), /Orders \(`src-orders`\): map tasks asked 3 times to write outside their scope/);
  assert.match(renderStats(stats), /3 tasks, \$0\.75, 2 delegations; by model: haiku 1 \(\$0\.05\), opus 1 \(\$0\.60\), default 1 \(\$0\.10\)/);
});

test("the hooks record edits (with the agent that made them and whether it stayed in its block) and reads", () => {
  const root = mappedShop();
  const model = shopModel();
  writeProjectIndex(root, analyze(root, { model, skipGit: true }), model);
  const edit = (file, extra = {}) => handleHook("pre-edit", { tool_input: { file_path: path.join(root, file) }, cwd: root, ...extra }, root);
  edit("src/orders/index.ts", { agent_type: "block-src-checkout" });
  edit("src/checkout/index.ts", { agent_type: "block-src-checkout" });
  edit("src/web/checkout-page.ts");
  handleHook("post-edit", { tool_input: { file_path: path.join(root, "src/web/checkout-page.ts") }, cwd: root }, root);
  reportRead({ tool_name: "Read", tool_input: { file_path: path.join(root, "src/pricing/index.ts") }, cwd: root, agent_type: "block-src-checkout" }, root);
  reportRead({ tool_name: "Bash", tool_input: {}, cwd: root }, root);
  reportRead({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: root }, root);
  reportRead({ tool_name: "Grep", tool_input: { path: path.join(root, "src/orders/index.ts"), pattern: "SECRET" }, cwd: root, agent_type: "block-src-checkout" }, root);
  reportRead({ tool_name: "Grep", tool_input: { path: path.join(root, "src/orders"), pattern: "x" }, cwd: root }, root);
  reportRead({ tool_name: "Grep", tool_input: { pattern: "x" }, cwd: root }, root);
  const events = readUsage(root);
  const edits = events.filter((event) => event.kind === "edit");
  assert.deepEqual(edits.map((event) => [event.phase, event.file, event.block, event.outside === true]), [
    ["before", "src/orders/index.ts", "src-orders", true],
    ["before", "src/checkout/index.ts", "src-checkout", false],
    ["before", "src/web/checkout-page.ts", "src-web", false],
    ["after", "src/web/checkout-page.ts", "src-web", false],
  ]);
  assert.ok(edits[0].note > 0, "the note shown to the agent has a size");
  const reads = events.filter((event) => event.kind === "read").map(({ t, ...event }) => event);
  assert.deepEqual(reads, [
    { kind: "read", file: "src/pricing/index.ts", block: "src-pricing", agent: "block-src-checkout" },
    { kind: "read", file: path.relative(root, path.resolve(root, "/etc/hosts")).split(path.sep).join("/"), outside: true },
    { kind: "read", file: "src/orders/index.ts", block: "src-orders", agent: "block-src-checkout" },
  ], "Read, and Grep or Glob in a file (a folder names none); a file outside the project by its path from the root");
  assert.doesNotMatch(fs.readFileSync(path.join(root, USAGE_FILE), "utf8"), /SECRET/, "what a search looks for is not kept");
});

test("the MCP server records every tool call, the briefings (with how they were given) and the searches", async (t) => {
  const root = mappedShop();
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root, "--no-ui"], stderr: "pipe" }));
  t.after(() => client.close());
  await client.callTool({ name: "map", arguments: {} });
  await client.callTool({ name: "block_context", arguments: { block: "src-checkout" } });
  await client.callTool({ name: "find_api", arguments: { query: "createOrder" } });
  await client.callTool({ name: "find_api", arguments: { query: "zzzzqq" } });
  await client.callTool({ name: "block_context", arguments: { block: "nope" } });
  const events = readUsage(root);
  assert.deepEqual(events.filter((event) => event.kind === "tool").map((event) => [event.tool, event.ok]), [["map", true], ["block_context", true], ["find_api", true], ["find_api", true], ["block_context", false]]);
  const briefing = events.find((event) => event.kind === "briefing");
  assert.deepEqual([briefing.scope, briefing.mode], [["src-checkout"], "files"], "a small neighbor API is given whole");
  assert.ok(briefing.tokens > 0 && briefing.own > 0);
  assert.deepEqual(events.filter((event) => event.kind === "search").map((event) => [event.query, event.hits > 0]), [["createOrder", true], ["zzzzqq", false]]);
});

test("cantus stats prints the summary or JSON, and says so when nothing is recorded", () => {
  const root = mappedShop();
  const run = (...args) => spawnSync(process.execPath, [cli, "stats", "-C", root, ...args], { encoding: "utf8" });
  assert.match(run().stdout, /Nothing recorded yet/);
  recordUsage(root, { kind: "search", query: "refund", hits: 0 });
  recordUsage(root, { kind: "search", query: "refund", hits: 0 });
  assert.match(run().stdout, /Searches that found nothing\n  "refund" ×2/);
  assert.equal(JSON.parse(run("--json").stdout).misses[0].query, "refund");
  assert.match(run("--days", "0").stderr, /--days must be a positive number/);
});

test("the live map serves the statistics, with the advice as data the page words in its language", async (t) => {
  const root = mappedShop();
  for (let i = 0; i < 3; i++) recordUsage(root, { kind: "read", file: "src/orders/index.ts", block: "src-orders", agent: "block-src-checkout" });
  recordUsage(root, { kind: "tool", tool: "block_context", ok: true, tokens: 900 });
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());
  const get = (pathname, token) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.port, path: pathname, headers: { host: `127.0.0.1:${server.port}`, ...(token ? { "x-cantus-token": token } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: raw }));
    }).on("error", reject);
  });
  const page = await get("/");
  const token = /"token":"([0-9a-f]+)"/.exec(page.text)[1];
  assert.match(page.text, /id="statsview"/);
  assert.equal((await get("/api/stats")).status, 403, "the statistics need the token too");
  const stats = JSON.parse((await get("/api/stats?days=7", token)).text);
  assert.deepEqual(stats.advice, [{ kind: "outside-read", block: "src-checkout", file: "src/orders/index.ts", ownedBy: "src-orders", count: 3 }]);
  assert.equal(stats.suggestions.length, 1);
  assert.equal(stats.tools.block_context.calls, 1);
});
