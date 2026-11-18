import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, findBreakingChanges, handleHook, renderContextPrompt, writeProjectIndex } from "../dist/index.js";
import { readChanges } from "../dist/state/changes.js";
import { apiChanges } from "../dist/state/impact.js";
import { copyFixture } from "./helpers.mjs";

test("Python: blocks split the package under src/, tests stay out", () => {
  const analysis = analyze(copyFixture("python"), { skipGit: true });
  assert.deepEqual(analysis.blocks.map((info) => `${info.block.id} ${info.files.join(",")}`), [
    "shop-py src/shop/__init__.py",
    "src-shop-api src/shop/api/app.py",
    "src-shop-db src/shop/db/__init__.py,src/shop/db/store.py",
    "src-shop-orders src/shop/orders/__init__.py,src/shop/orders/service.py",
    "src-shop-pricing src/shop/pricing/__init__.py,src/shop/pricing/rules.py",
  ], "src/shop only wraps the package: its subpackages are the blocks; tests/test_orders.py is not code of a block");
  assert.ok(analysis.blocks.every((info) => info.tokens > 0));
});

test("Python: imports become dependencies and call sites, through re-exports and module attributes", () => {
  const analysis = analyze(copyFixture("python"), { skipGit: true });
  assert.deepEqual(analysis.callSites.map((site) => `${site.file}:${site.line} ${site.symbol} -> ${site.targetFile} (${site.targetBlock})`), [
    "src/shop/api/app.py:9 create_order -> src/shop/orders/service.py (src-shop-orders)",
    "src/shop/api/app.py:10 OrderService -> src/shop/orders/service.py (src-shop-orders)",
    "src/shop/api/app.py:11 total -> src/shop/pricing/rules.py (src-shop-pricing)",
    "src/shop/orders/service.py:14 total -> src/shop/pricing/rules.py (src-shop-pricing)",
    "src/shop/orders/service.py:15 save -> src/shop/db/store.py (src-shop-db)",
  ], "`from shop import create_order` reaches the function its __init__.py re-exports; `service.OrderService` and `shop.pricing.rules.total` name the member");
  assert.ok(analysis.callSites.every((site) => site.via === "import" && site.match === "certain"));
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to} [${dep.symbols.join(",")}]`), [
    "shop-py->src-shop-orders [create_order]",
    "src-shop-api->shop-py [create_order]",
    "src-shop-api->src-shop-orders [*]",
    "src-shop-api->src-shop-pricing [*]",
    "src-shop-orders->src-shop-db [save]",
    "src-shop-orders->src-shop-pricing [total]",
  ]);
  const byId = Object.fromEntries(analysis.blocks.map((info) => [info.block.id, info]));
  assert.deepEqual(byId["src-shop-orders"].externalPackages, ["requests"], "`from __future__` is not a package");
  assert.deepEqual(byId["src-shop-db"].externalPackages, ["os", "sqlite3"], "the standard library is external, like Node's built-ins");
  assert.deepEqual(analysis.unresolvedImports.map((entry) => `${entry.specifier}: ${entry.reason}`), [
    "shop.missing: no module shop.missing in the project's package shop",
    ".: . is a folder without __init__.py and has no module nowhere",
  ], "an import under the project's own package that finds no file is a mistake, not an installed package");
});

test("Python: the catalog lists public functions, classes and variables with their signatures and docstrings", () => {
  const analysis = analyze(copyFixture("python"), { skipGit: true });
  const entries = analysis.catalog.filter((entry) => entry.block === "src-shop-orders");
  assert.deepEqual(entries.map((entry) => `${entry.kind} ${entry.name}`), ["function create_order", "variable DEFAULT_CURRENCY", "class OrderService"]);
  const create = entries.find((entry) => entry.name === "create_order");
  assert.equal(create.signature, "def create_order(items: list[float], customer: str, *, discount: float = 0) -> dict");
  assert.equal(create.doc, "Creates an order and stores it.", "the first paragraph of the docstring");
  assert.ok(create.bodyHash, "function bodies are hashed to spot re-implementations");
  const service = entries.find((entry) => entry.name === "OrderService");
  assert.equal(service.signature, "class OrderService:\n    currency: str\n    def __init__(self, customer: str)\n    def place(self, items: list[float]) -> dict", "public members and the constructor, not _audit");
  assert.ok(!analysis.catalog.some((entry) => entry.name === "_helper" || entry.name === "_connection"), "a leading underscore is private");
});

test("Python: __all__ decides what a module exports", () => {
  const root = copyFixture("python");
  fs.writeFileSync(path.join(root, "src/shop/pricing/rules.py"), fs.readFileSync(path.join(root, "src/shop/pricing/rules.py"), "utf8") + '\n__all__ = ["total"]\n');
  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(analysis.catalog.filter((entry) => entry.file === "src/shop/pricing/rules.py").map((entry) => entry.name), ["total"], "TAX is public by name but not listed");
});

test("Python: a block's briefing shows the contracts of the modules it imports", () => {
  const root = copyFixture("python");
  const analysis = analyze(root, { skipGit: true });
  const prompt = renderContextPrompt(buildContextPack(analysis, "src-shop-orders"), { root, inlineSources: false });
  assert.match(prompt, /`src\/shop\/pricing\/rules\.py`\n```python\nTAX: float\n\n# Sum of the items, discounted, with tax\.\ndef total\(items: list\[float\], discount: float = 0\) -> float\n```/);
  assert.match(prompt, /`src\/shop\/pricing\/__init__\.py`\n```python\n# no exported declarations\n```/);
});

test("Python: changing a signature others call is a breaking change; the cache re-reads the changed file", () => {
  const root = copyFixture("python");
  const before = analyze(root, { skipGit: true });
  assert.ok(fs.existsSync(path.join(root, ".cantus/cache/analysis.json")));
  const rules = path.join(root, "src/shop/pricing/rules.py");
  fs.writeFileSync(rules, fs.readFileSync(rules, "utf8").replace("discount: float = 0) -> float", "discount: float, currency: str) -> float"));
  const after = analyze(root, { skipGit: true });
  assert.equal(after.catalog.find((entry) => entry.name === "total").signature, "def total(items: list[float], discount: float, currency: str) -> float");
  const findings = findBreakingChanges(before, after, "src-shop-pricing");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^total changed from `def total\(items: list\[float\], discount: float = 0\) -> float` to `def total\(items: list\[float\], discount: float, currency: str\) -> float`; callers in other blocks: src\/shop\/api\/app\.py:11, src\/shop\/orders\/service\.py:14$/);
});

test("languages Cantus does not read yet still belong to their blocks", () => {
  const root = copyFixture("python");
  fs.mkdirSync(path.join(root, "src/shop/native"));
  fs.writeFileSync(path.join(root, "src/shop/native/lib.zig"), "pub fn fastTotal() void {}\n");
  fs.mkdirSync(path.join(root, "src/shop/native/target"));
  fs.writeFileSync(path.join(root, "src/shop/native/target/build.zig"), "pub fn main() void {}\n");
  const analysis = analyze(root, { skipGit: true });
  const native = analysis.blocks.find((info) => info.block.id === "src-shop-native");
  assert.deepEqual(native.files, ["src/shop/native/lib.zig"], "a folder of a language not read yet is a block with its file; target/ is build output");
  assert.ok(native.tokens > 0);
  assert.match(analysis.diagnostics.find((diagnostic) => /does not read yet/.test(diagnostic.message)).message, /^1 source file\(s\) in languages Cantus does not read yet \(\.zig\)/);
});

test("Python: the post-edit hook warns when an edit changes a function other blocks call", () => {
  const root = copyFixture("python");
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  const rules = path.join(root, "src/shop/pricing/rules.py");
  const original = fs.readFileSync(rules, "utf8");
  const edit = () => handleHook("post-edit", { cwd: root, tool_name: "Edit", tool_input: { file_path: rules } }, root);

  fs.writeFileSync(rules, original.replace("return sum(items)", "return 0 + sum(items)"));
  assert.equal(edit(), undefined, "a change inside the body is not an API change");

  fs.writeFileSync(rules, original.replace("discount: float = 0) -> float", "discount: float, currency: str) -> float"));
  const changed = edit().hookSpecificOutput.additionalContext;
  assert.match(changed, /^Cantus: this edit changes the API of src\/shop\/pricing\/rules\.py that other blocks rely on/);
  assert.match(changed, /- total changed its declaration; other blocks call it: src\/shop\/api\/app\.py:11, src\/shop\/orders\/service\.py:14/);

  fs.writeFileSync(rules, original.replace("def total(", "def _total("));
  assert.match(edit().hookSpecificOutput.additionalContext, /- total is no longer exported, but other blocks use it/);

  fs.writeFileSync(rules, original.replace("def total(items", "def total(items, (("));
  assert.equal(edit(), undefined, "a file that does not parse is mid-edit: no warning");
});

test("Python: API changes since the last commit, with their callers", () => {
  const root = copyFixture("python");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  const rules = path.join(root, "src/shop/pricing/rules.py");
  fs.writeFileSync(rules, fs.readFileSync(rules, "utf8").replace("discount: float = 0) -> float", "discount: float, currency: str) -> float").replace("TAX: float = 0.22", "VAT: float = 0.22"));
  const analysis = analyze(root);
  const api = apiChanges(root, analysis, readChanges(root));
  assert.deepEqual(api.map((change) => `${change.kind} ${change.name} ${change.callers.length}`), ["changed total 2", "removed TAX 0", "added VAT 0"]);
  assert.equal(api[0].before, "def total(items: list[float], discount: float = 0) -> float");
  assert.equal(api[0].after, "def total(items: list[float], discount: float, currency: str) -> float");
});

test("Python web: Flask, FastAPI and Django routes become endpoints that the front end's calls reach", () => {
  const analysis = analyze(copyFixture("pyweb"), { skipGit: true });
  assert.deepEqual(analysis.endpoints.map((endpoint) => `${endpoint.method ?? "ANY"} ${endpoint.route} ${endpoint.file}:${endpoint.line} ${endpoint.handler}`), [
    "GET /api/orders flaskapp/app.py:8 orders_root",
    "POST /api/orders flaskapp/app.py:8 orders_root",
    "GET /api/orders/{…} flaskapp/app.py:15 order_detail",
    "GET /health flaskapp/app.py:20 health",
    "GET /ping fastapp/main.py:10 ping",
    "ANY /shop/cart shop/views.py:9 CartView",
    "ANY /shop/products/{…} shop/views.py:5 product_detail",
    "ANY /shop/search/{…} shop/views.py:14 search",
    "POST /v1/users fastapp/users.py:12 create_user",
    "GET /v1/users/{…} fastapp/users.py:7 read_user",
  ], "Blueprint url_prefix, include_router(module.router, prefix=…) and include() prefixes are joined; <int:id>, {id} and regex groups become {…}");
  const http = analysis.callSites.filter((site) => site.via === "http").map((site) => `${site.file}:${site.line} ${site.symbol} -> ${site.targetFile}`);
  assert.deepEqual(http, [
    "frontend/app.js:2 orders_root -> flaskapp/app.py",
    "frontend/app.js:3 order_detail -> flaskapp/app.py",
    "frontend/app.js:4 read_user -> fastapp/users.py",
    "frontend/app.js:5 product_detail -> shop/views.py",
    "frontend/app.js:6 health -> flaskapp/app.py",
  ]);
  const frontend = analysis.dependencies.find((dependency) => dependency.from === "frontend" && dependency.to === "fastapp");
  assert.ok(frontend, "the front end block depends on the FastAPI block through the HTTP call");
});

test("an API client function named request, passing the verb in an options variable, links the front end to FastAPI routes", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-pyclient-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("app/__init__.py", "");
  write("app/api.py", [
    "from fastapi import FastAPI",
    "",
    "app = FastAPI()",
    "",
    '@app.get("/groups")',
    "def list_groups():",
    "    return []",
    "",
    '@app.post("/groups/{gid}/expenses")',
    "def add_expense(gid: int):",
    "    return {}",
    "",
    '@app.delete("/groups/{gid}/expenses/{eid}")',
    "def remove_expense(gid: int, eid: int):",
    "    return {}",
  ].join("\n"));
  write("web/client.js", [
    "async function request(method, path, body) {",
    "  const opts = { method, headers: {} };",
    '  if (body !== undefined) opts.body = JSON.stringify(body);',
    "  const res = await fetch(path, opts);",
    "  return res.json();",
    "}",
    "",
    'export const listGroups = () => request("GET", "/groups");',
    "export const addExpense = (gid, expense) => request(\"POST\", `/groups/${gid}/expenses`, expense);",
    "export const removeExpense = (gid, eid) => request(\"DELETE\", `/groups/${gid}/expenses/${eid}`);",
  ].join("\n"));
  const analysis = analyze(root, { skipGit: true });
  const http = analysis.callSites.filter((site) => site.via === "http").map((site) => `${site.file}:${site.line} ${site.symbol}`).sort();
  assert.deepEqual(http, [
    "web/client.js:10 remove_expense",
    "web/client.js:8 list_groups",
    "web/client.js:9 add_expense",
  ].sort(), "each call reaches the route of its own verb: the verb comes from the options object the wrapper passes to fetch");
});
