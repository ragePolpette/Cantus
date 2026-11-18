import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, blockForFile, check, findCycles, folderName, scanSourceFiles, weakestLink } from "../dist/index.js";
import { execFileSync } from "node:child_process";
import { fixtures, shopModel } from "./helpers.mjs";

const shop = path.join(fixtures, "shop");

test("infers one block per source directory with stable, path-derived ids", () => {
  const analysis = analyze(shop, { skipGit: true });
  assert.deepEqual(
    analysis.blocks.map((info) => info.block.id),
    ["src-checkout", "src-db", "src-orders", "src-payments", "src-pricing", "src-web"],
  );
  assert.equal(analysis.blocks.find((info) => info.block.id === "src-db").block.layer, "infrastructure");
  assert.equal(analysis.blocks.find((info) => info.block.id === "src-web").block.layer, "interface");
  assert.equal(analyze(shop, { skipGit: true }).blocks[0].block.id, analysis.blocks[0].block.id);
});

test("resolves imports into block dependencies with the symbols used", () => {
  const analysis = analyze(shop, { skipGit: true });
  const edges = analysis.dependencies.map((dep) => `${dep.from}->${dep.to}:${dep.symbols.join(",")}`);
  assert.deepEqual(edges, [
    "src-checkout->src-orders:Order,createOrder",
    "src-checkout->src-payments:charge",
    "src-checkout->src-pricing:quote",
    "src-orders->src-db:db",
    "src-web->src-checkout:placeOrder",
    "src-web->src-db:db",
  ]);
  assert.deepEqual(analysis.unresolvedImports, []);
  assert.deepEqual(analysis.blocks.find((info) => info.block.id === "src-payments").externalPackages, ["stripe"]);
});

test("extracts contracts as declarations, including referenced sibling files", () => {
  const analysis = analyze(shop, { skipGit: true });
  assert.match(analysis.contracts["src/checkout/index.ts"], /export declare function placeOrder\(cart: Cart\): Promise<Order>;/);
  assert.match(analysis.contracts["src/checkout/cart.ts"], /export interface Cart/);
  assert.doesNotMatch(analysis.contracts["src/orders/index.ts"], /ORDERS_INTERNAL_42/);
  const web = analysis.dependencies.find((dep) => dep.from === "src-web" && dep.to === "src-checkout");
  assert.deepEqual(web.files, ["src/checkout/cart.ts", "src/checkout/index.ts"]);
});

test("resolves workspace packages to their sources without node_modules", () => {
  const analysis = analyze(path.join(fixtures, "mono"), { skipGit: true });
  assert.deepEqual(analysis.blocks.map((info) => info.block.id), ["packages-app", "packages-core"]);
  assert.deepEqual(
    analysis.dependencies.map((dep) => `${dep.from}->${dep.to}:${dep.symbols.join(",")}`),
    ["packages-app->packages-core:greet"],
  );
});

test("uses the model's blocks, so drift and layer rules are checked by id", () => {
  const model = shopModel();
  const analysis = analyze(shop, { model, skipGit: true });
  const findings = check(analysis, model);

  const undeclared = findings.filter((finding) => finding.kind === "undeclared-dependency");
  assert.equal(undeclared.length, 1);
  assert.equal(undeclared[0].from, "src-web");
  assert.equal(undeclared[0].to, "src-db");
  assert.equal(undeclared[0].severity, "info", "the map is a guide: code ahead of it is information");
  assert.match(undeclared[0].message, /Not on the map yet/);

  const strict = check(analysis, model, { strict: true });
  assert.equal(strict.find((finding) => finding.kind === "undeclared-dependency").severity, "error");
  assert.ok(strict.filter((finding) => finding.kind === "layer-violation").every((finding) => finding.severity === "error"));
  assert.equal(check(analysis, { ...model, strict: true }).find((finding) => finding.kind === "undeclared-dependency").severity, "error");

  const violations = findings.filter((finding) => finding.kind === "layer-violation").map((finding) => `${finding.from}->${finding.to}`);
  assert.deepEqual(violations.sort(), ["src-orders->src-db", "src-web->src-db"]);
});

test("reports files outside every block and declared-but-unused dependencies", () => {
  const model = shopModel();
  model.blocks = model.blocks.filter((block) => block.id !== "src-pricing");
  model.dependencies = model.dependencies.filter((dep) => dep.to !== "src-pricing");
  model.dependencies.push({ from: "src-web", to: "src-orders" });
  const findings = check(analyze(shop, { model, skipGit: true }), model);
  assert.ok(findings.some((finding) => finding.kind === "unassigned-files" && finding.message.includes("src/pricing/index.ts")));
  assert.ok(findings.some((finding) => finding.kind === "unused-dependency" && finding.from === "src-web" && finding.to === "src-orders"));
});

test("finds cycles as strongly connected components", () => {
  const dep = (from, to) => ({ from, to, symbols: [], files: [], imports: [] });
  assert.deepEqual(findCycles([dep("a", "b"), dep("b", "c"), dep("c", "a"), dep("c", "d")]), [["a", "b", "c"]]);
  assert.deepEqual(findCycles([dep("a", "b")]), []);
});

test("a cycle names its weakest arrow, and says whether taking it out ends the cycle", () => {
  const dep = (from, to, symbols, file = `${from}/x.ts`) => ({ from, to, symbols, files: [], imports: [{ file, target: `${to}/y.ts`, specifier: `../${to}` }] });
  const deps = [dep("a", "b", ["f", "g", "h"]), dep("b", "c", ["i", "j"]), dep("c", "a", ["Config"], "c/root.ts")];
  const sentence = weakestLink(["a", "b", "c"], deps);
  assert.equal(sentence, " Weakest arrow: c → a, only `Config` in `c/root.ts`; without it the cycle is gone.");
  // Two cycles sharing the weakest arrow's block: removing one arrow is not enough.
  const twice = [...deps, dep("b", "a", ["k", "l", "m"]), dep("c", "b", ["n", "o", "p", "q"])];
  assert.match(weakestLink(["a", "b", "c"], twice), /^ Weakest arrow: c → a, only `Config` in `c\/root\.ts`\.$/);
  assert.equal(weakestLink(["a", "b"], []), "");
});

test("assigns files to the block with the longest matching include", () => {
  const blocks = [
    { id: "app", name: "App", layer: "application", include: ["src"] },
    { id: "auth", name: "Auth", layer: "domain", include: ["src/auth"] },
    { id: "single", name: "Single", layer: "domain", include: ["src/util.ts"] },
  ];
  assert.equal(blockForFile(blocks, "src/auth/login.ts").id, "auth");
  assert.equal(blockForFile(blocks, "src/main.ts").id, "app");
  assert.equal(blockForFile(blocks, "src/util.ts").id, "single");
  assert.equal(blockForFile(blocks, "src/authz.ts").id, "app");
  assert.equal(blockForFile(blocks, "lib/x.ts"), undefined);
});

test("collects the backend boundary: HTTP calls with literal URLs", () => {
  const analysis = analyze(path.join(fixtures, "http"), { skipGit: true });
  assert.deepEqual(
    analysis.httpCalls.map((call) => `${call.file}:${call.method} ${call.url}`).sort(),
    [
      "src/lib/client.js:DELETE /api/items",
      "src/lib/client.js:POST /api/upload",
      "src/ui/catalog.js:GET /api/catalog",
      "src/ui/catalog.js:GET /api/search",
      "src/ui/catalog.js:POST /api/catalog",
    ],
  );
  const ui = analysis.blocks.find((info) => info.block.id === "src-ui");
  assert.deepEqual(ui.httpEndpoints, ["GET /api/catalog", "GET /api/search", "POST /api/catalog"]);
});

test("calls that merely look like HTTP helpers are not endpoints", () => {
  const analysis = analyze(path.join(fixtures, "http"), { skipGit: true });
  const urls = analysis.httpCalls.map((call) => call.url);
  assert.ok(!urls.includes("name"), "member .get() of a local object is not an ajax call");
  assert.ok(!urls.includes("notes.txt"), ".open() with a non-HTTP verb is not an XHR call");
});

test("exclude patterns can be globs for vendored and generated files", () => {
  const vendor = path.join(fixtures, "vendor");
  assert.deepEqual(scanSourceFiles(vendor), [
    "assets/plugins/legacy/tool.js",
    "assets/plugins/legacy/tool.min.js",
    "src/app/index.js",
    "src/app/index.min.js",
  ]);
  assert.deepEqual(scanSourceFiles(vendor, ["**/*.min.js"]), ["assets/plugins/legacy/tool.js", "src/app/index.js"]);
  assert.deepEqual(scanSourceFiles(vendor, ["assets/plugins/**"]), ["src/app/index.js", "src/app/index.min.js"]);
  assert.deepEqual(scanSourceFiles(vendor, ["*.min.js"]), ["assets/plugins/legacy/tool.js", "src/app/index.js"]);
  assert.deepEqual(scanSourceFiles(vendor, ["src/app/*.min.js"]), ["assets/plugins/legacy/tool.js", "assets/plugins/legacy/tool.min.js", "src/app/index.js"]);
});

test("globs in the model's analysis.exclude keep vendored code out of the map", () => {
  const vendor = path.join(fixtures, "vendor");
  const model = {
    version: 1,
    name: "vendor-fixture",
    blocks: [{ id: "src-app", name: "App", layer: "application", include: ["src/app"] }],
    dependencies: [],
    rules: { allow: {} },
    analysis: { exclude: ["**/*.min.js", "assets/plugins/**"] },
  };
  const analysis = analyze(vendor, { model, skipGit: true });
  assert.deepEqual(analysis.blocks[0].files, ["src/app/index.js"]);
  assert.deepEqual(analysis.unassignedFiles, []);
});

test("HTTP calls in legacy and Vue code: built URLs, jQuery settings, run-time URLs counted", () => {
  const analysis = analyze(path.join(fixtures, "http-legacy"), { skipGit: true });
  assert.deepEqual(analysis.httpCalls.map((call) => `${call.file}:${call.line} ${call.method} ${call.url}`), [
    "js/orders/orders.js:5 POST /api/orders",
    "js/orders/orders.js:6 POST /services/OrderService.asmx/GetOrders",
    "js/orders/orders.js:7 PUT /api/legacy",
    "js/orders/orders.js:8 GET /api/stats",
    "js/orders/orders.js:9 GET /api/orders/{…}/lines",
    "js/orders/orders.js:10 POST /api/orders/{…}/confirm",
    "js/orders/orders.js:12 GET /api/ping",
    "js/orders/orders.js:23 GET {…}x",
    "js/vue/list.js:5 GET /api/items",
    "js/vue/list.js:6 DELETE /api/items/{…}",
  ]);
  const orders = analysis.blocks.find((info) => info.block.id === "js");
  assert.equal(orders.dynamicHttpCalls, 2, "$.ajax({ url: url }) and fetch(window.location.href)");
  const log = analysis.diagnostics.find((diagnostic) => diagnostic.stage === "http");
  assert.match(log.message, /2 HTTP call\(s\) with a URL built entirely at run time/);
  assert.match(log.detail, /16: \$\.ajax\(\{ url: url \}\);/);
});

test("a tsconfig extending a config that is not installed does not hide the project's own imports", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-extends-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "apps/*"] }));
  write("packages/db/package.json", JSON.stringify({ name: "@x/db", exports: { ".": "./src/index.ts", "./expo": "./src/drivers/expo.ts" } }));
  write("packages/db/src/index.ts", "export const db = 1;\n");
  write("packages/db/src/drivers/expo.ts", "export const driver = 2;\n");
  write("apps/mobile/package.json", JSON.stringify({ name: "mobile" }));
  write("apps/mobile/tsconfig.json", '// comment\n{ "extends": "expo/tsconfig.base", "compilerOptions": { "paths": { "@/*": ["./src/*"], }, }, }\n');
  write("apps/mobile/src/ui/theme.ts", "export const theme = {};\n");
  write("apps/mobile/src/ui/Button.ts", 'import { theme } from "./theme";\nexport const button = theme;\n');
  write("apps/mobile/src/features/home/Home.ts", 'import { button } from "@/ui/Button";\nimport { driver } from "@x/db/expo";\nimport { db } from "@x/db";\nexport const home = [button, driver, db];\n');

  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(analysis.unresolvedImports, [], "relative imports, the tsconfig's own alias and a package's exports all resolve");
  const imports = analysis.fileImports.map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(imports, [
    "apps/mobile/src/features/home/Home.ts->apps/mobile/src/ui/Button.ts",
    "apps/mobile/src/features/home/Home.ts->packages/db/src/drivers/expo.ts",
    "apps/mobile/src/features/home/Home.ts->packages/db/src/index.ts",
    "apps/mobile/src/ui/Button.ts->apps/mobile/src/ui/theme.ts",
  ]);
  const warning = analysis.diagnostics.find((diagnostic) => /extends "expo\/tsconfig\.base", which is not installed/.test(diagnostic.message));
  assert.ok(warning, "the map says it was read without the extended config");
  assert.equal(warning.file, "apps/mobile/tsconfig.json");
  assert.equal(warning.level, "warning");
});

test("a project with no name of its own is called after its repository, not after the folder it is checked out in", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-name-"));
  const root = path.join(parent, "myrepo-feature-x");
  fs.mkdirSync(path.join(root, "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "web/a.js"), "export const a = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  assert.equal(folderName(root), "myrepo-feature-x", "not a git checkout");
  git("init", "-q", "-b", "main");
  assert.equal(folderName(root), "myrepo-feature-x", "no remote");
  git("remote", "add", "origin", "git@github.com:acme/myrepo.git");
  assert.equal(folderName(root), "myrepo");
  git("remote", "set-url", "origin", "https://github.com/acme/other-name.git/");
  assert.equal(folderName(root), "other-name");
  assert.equal(analyze(root, { skipGit: true }).name, "other-name");
  // A subfolder of the checkout keeps its own name: it was chosen.
  assert.equal(folderName(path.join(root, "web")), "web");
});

test("a Properties folder holding only AssemblyInfo is not a block of its own", async () => {
  const { inferBlocks } = await import("../dist/index.js");
  const files = ["Orders/a.cs", "Orders/b.cs", "Billing/c.cs", "Properties/AssemblyInfo.cs", "Program.cs"];
  const blocks = inferBlocks("/nowhere", files);
  assert.ok(!blocks.some((block) => block.include.includes("Properties")), blocks.map((block) => block.id).join(","));
  const withCode = inferBlocks("/nowhere", [...files, "Properties/Settings.cs"]);
  assert.ok(withCode.some((block) => block.include.includes("Properties")), "a Properties folder with code of its own stays a block");
});
