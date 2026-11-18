import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyze } from "../dist/index.js";
import { traceTarget } from "../dist/analysis/trace.js";
import { copyFixture } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function project() {
  const root = copyFixture("csharp");
  fs.writeFileSync(path.join(root, "web/orders.html"), '<html><body><script src="js/orders.js"></script><script>\n$.ajax({ url: "/api/legacy", type: "POST" });\n</script></body></html>\n');
  return root;
}

test("trace: a route gives the calls that reach it and the handler", () => {
  const analysis = analyze(project(), { skipGit: true });
  const text = traceTarget(analysis, "/api/orders");
  assert.match(text, /### GET \/api\/Orders\/\{…\} → OrdersController\.Get \(Controllers\/OrdersController\.cs:\d+\)/);
  assert.match(text, /### POST \/api\/Orders → OrdersController\.Create/);
  assert.match(text, /- `web\/js\/orders\.js:4` \(web\) GET \/api\/orders\/\{…\} → OrdersController\.Get \(Controllers\/OrdersController\.cs:\d+\); loaded by `web\/orders\.html`: `fetch\("\/api\/orders\/" \+ id\);`/);
  assert.doesNotMatch(text, /LegacyController/);

  const post = traceTarget(analysis, "POST /api/orders");
  assert.match(post, /OrdersController\.Create/);
  assert.doesNotMatch(post, /OrdersController\.Get/);
});

test("trace: a handler, with its type or by the method name alone", () => {
  const analysis = analyze(project(), { skipGit: true });
  assert.match(traceTarget(analysis, "OrdersController.Create"), /### POST \/api\/Orders → OrdersController\.Create[^]*Called from:\n- `web\/js\/orders\.js:5`/);
  assert.match(traceTarget(analysis, "SaveDraft"), /### POST \/Default\.aspx\/SaveDraft → _Default\.SaveDraft/);
});

test("trace: a page gives its scripts and the endpoints they call, inline ones included", () => {
  const analysis = analyze(project(), { skipGit: true });
  const text = traceTarget(analysis, "orders.html");
  assert.match(text, /### Page `web\/orders\.html`/);
  assert.match(text, /Loads 1 script\(s\), in page order: `web\/js\/orders\.js`/);
  assert.match(text, /`web\/js\/orders\.js:2` \(web\) POST \/Services\/OrderService\.asmx\/GetOrders → OrderService\.GetOrders/);
  assert.match(text, /`web\/orders\.html:2` \(web\) POST \/api\/legacy → LegacyController\.Post[^\n]*\(inline in the page\)/);
});

test("trace: a page with many scripts lists all of them in page order, and what it is built from", () => {
  const root = project();
  const names = Array.from({ length: 30 }, (_, index) => `s${String(index).padStart(2, "0")}`);
  for (const name of names) fs.writeFileSync(path.join(root, `web/js/${name}.js`), `function ${name}Run() { return 1; }\n`);
  fs.writeFileSync(path.join(root, "web/big.aspx"), `<%@ Page MasterPageFile="~/web/frame.master" %>\n${names.map((name) => `<script src="js/${name}.js"></script>`).join("\n")}\n`);
  fs.writeFileSync(path.join(root, "web/frame.master"), '<script src="js/orders.js"></script>\n');
  const text = traceTarget(analyze(root, { skipGit: true }), "big.aspx");
  assert.match(text, /Loads 30 script\(s\), in page order: `web\/js\/s00\.js`, `web\/js\/s01\.js`/);
  assert.ok(text.includes("`web/js/s29.js`") && !/more/.test(text.split("\n").find((line) => line.startsWith("Loads"))), "the last one is there, nothing is cut");
  assert.match(text, /Built from: `web\/frame\.master`/);
});

test("trace: an unknown target is said, not guessed", () => {
  const analysis = analyze(project(), { skipGit: true });
  assert.match(traceTarget(analysis, "/api/nowhere"), /^Nothing in the map matches `\/api\/nowhere`/);
  assert.throws(() => traceTarget(analysis, "  "), /Pass a route/);
});

test("MCP trace answers over the tool", async (t) => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", project()], stderr: "pipe" }));
  t.after(() => client.close());
  const result = await client.callTool({ name: "trace", arguments: { target: "/api/orders" } });
  assert.match(result.content[0].text, /OrdersController\.Get/);
});
