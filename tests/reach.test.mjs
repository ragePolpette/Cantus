import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyze, buildViewData, describeImpact, reach } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const edges = (...pairs) => pairs.map(([from, to]) => ({ from, to }));

test("reach follows dependencies nearest first and keeps a shortest chain", () => {
  // web → checkout → orders → db, and web → db directly; a cycle between db and cache.
  const deps = edges(["web", "checkout"], ["checkout", "orders"], ["orders", "db"], ["web", "db"], ["db", "cache"], ["cache", "db"]);
  assert.deepEqual(reach(deps, "db", "dependents").map((entry) => [entry.block, entry.distance, entry.path.join(">")]), [
    ["cache", 1, "db>cache"],
    ["orders", 1, "db>orders"],
    ["web", 1, "db>web"],
    ["checkout", 2, "db>orders>checkout"],
  ]);
  assert.deepEqual(reach(deps, "web", "dependencies").map((entry) => [entry.block, entry.distance]), [["checkout", 1], ["db", 1], ["cache", 2], ["orders", 2]]);
  assert.deepEqual(reach(deps, "web", "dependents"), [], "nothing uses web");
  assert.deepEqual(reach([], "x", "dependents"), []);
});

test("describeImpact lists direct users with their call sites, then the ones reached through others", () => {
  const analysis = analyze(copyFixture("shop"), { model: shopModel(), skipGit: true });
  const text = describeImpact(analysis, "src-db");
  assert.match(text, /^# Impact of changing `src-db` \(Database\)/);
  assert.match(text, /3 of 5 other block\(s\) can be affected: 2 directly, 1 through others\./);
  assert.match(text, /- `src-orders` \(Orders\) — db; 1 call site\(s\)/);
  assert.match(text, /- `src-checkout` \(Checkout\), 2 steps: `src-checkout` → `src-orders` → `src-db`/);
  assert.match(describeImpact(analysis, "src-web"), /No block uses it: a change here stays inside the block\./);
  assert.match(describeImpact(analysis, "src-web"), /It depends on 5 block\(s\)/);
  assert.throws(() => describeImpact(analysis, "nope"), /Unknown block "nope"/);
});

test("the map data carries who a change reaches, for the amber outline", () => {
  const analysis = analyze(copyFixture("shop"), { model: shopModel(), skipGit: true });
  const view = buildViewData(analysis, shopModel(), []);
  assert.deepEqual(view.blocks.find((block) => block.id === "src-db").dependents, [
    { id: "src-orders", distance: 1 },
    { id: "src-web", distance: 1 },
    { id: "src-checkout", distance: 2 },
  ]);
  assert.deepEqual(view.blocks.find((block) => block.id === "src-web").dependents, []);
});

test("`cantus impact` takes a block or a file", () => {
  const root = copyFixture("shop");
  const run = (target) => spawnSync(process.execPath, [cli, "impact", target, "-C", root], { encoding: "utf8" });
  const byBlock = run("src-db");
  assert.equal(byBlock.status, 0);
  assert.match(byBlock.stdout, /Impact of changing `src-db`/);
  const byFile = run("src/db/index.ts");
  assert.equal(byFile.status, 0);
  assert.match(byFile.stdout, /Impact of changing `src-db`/);
  assert.equal(run("src/nowhere.ts").status, 1);
});

test("the impact tool answers over MCP", async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const ask = async (args) => {
    const result = await client.callTool({ name: "impact", arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
  const byFile = await ask({ file: "src/db/index.ts" });
  assert.match(byFile.text, /Impact of changing `src-db`/);
  assert.match(byFile.text, /\(Cantus: analysis of /, "stamped like the other tools that read");
  assert.equal((await ask({ block: "nope" })).isError, true);
  assert.equal((await ask({})).isError, true);
});
