import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, check, handleHook, renderContextPrompt, writeProjectIndex } from "../dist/index.js";
import { copyFixture, fixtures } from "./helpers.mjs";

const scripts = path.join(fixtures, "scripts");
const sites = (analysis) => analysis.callSites.map((site) => `${site.file}:${site.line} ${site.symbol} -> ${site.targetFile}`);

test("classic scripts: top-level declarations are globals, read from other scripts and pages", () => {
  const analysis = analyze(scripts, { skipGit: true });
  assert.deepEqual(analysis.scriptFiles, ["customers/helpers.js", "customers/page.js", "invoices/helpers.js", "invoices/page.js", "lib/format.js", "orders/orders.js"]);
  assert.deepEqual(sites(analysis), [
    "customers/page.js:2 formatLabel -> customers/helpers.js",
    "customers/page.js:2 loadOrders -> orders/orders.js",
    "invoices/page.js:2 formatLabel -> invoices/helpers.js",
    "orders/orders.js:2 notify -> lib/format.js",
    "orders/orders.js:3 formatMoney -> lib/format.js",
    "orders/orders.js:3 APP_VERSION -> lib/format.js",
    "web/customers.aspx:15 showCustomers -> customers/page.js",
  ], "render() calls its own local formatMoney: not a use of the global; formatLabel goes to the copy the same page loads");
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to} [${dep.symbols.join(",")}] ${dep.imports[0].specifier}`), [
    "customers->orders [loadOrders] global loadOrders",
    "orders->lib [APP_VERSION,formatMoney,notify] global notify",
  ]);
  const duplicate = analysis.diagnostics.find((diagnostic) => diagnostic.stage === "globals");
  assert.match(duplicate.message, /global `formatLabel` is defined in 2 files: customers\/helpers\.js, invoices\/helpers\.js/);
});

test("pages: script tags resolved from ~/, /, ../ and ResolveUrl, CDN skipped, missing noted; inline code read", () => {
  const analysis = analyze(scripts, { skipGit: true });
  assert.deepEqual(analysis.pages, [
    { file: "web/customers.aspx", scripts: ["lib/format.js", "orders/orders.js", "customers/helpers.js", "customers/page.js"], missing: ["/missing/gone.js"] },
    { file: "web/invoices.html", scripts: ["lib/format.js", "invoices/helpers.js", "invoices/page.js"], missing: [] },
  ]);
  assert.deepEqual(analysis.httpCalls.map((call) => `${call.file}:${call.line} ${call.method} ${call.url}`), ["web/customers.aspx:16 POST /api/session"], "inline code with server tags is still read");
  assert.ok(!analysis.diagnostics.some((diagnostic) => diagnostic.level === "error"));
  assert.deepEqual(analysis.blocks.find((info) => info.block.id === "lib").loadedBy, ["web/customers.aspx", "web/invoices.html"]);
});

test("globals get contracts and catalog entries (JSDoc types where written), and briefings explain them", () => {
  const analysis = analyze(scripts, { skipGit: true });
  const entry = (name) => analysis.catalog.find((candidate) => candidate.name === name);
  assert.equal(entry("formatMoney").signature, "function formatMoney(cents: number): string;");
  assert.equal(entry("loadOrders").block, "orders");
  assert.match(analysis.contracts["lib/format.js"], /export declare function formatMoney\(cents: number\): string;/);
  const prompt = renderContextPrompt(buildContextPack(analysis, "lib", undefined, check(analysis)), { root: scripts, inlineSources: false });
  assert.match(prompt, /- 1 file\(s\) here are classic scripts: they share the page's global scope/);
  assert.match(prompt, /- Loaded by 2 page\(s\) with <script> tags: `web\/customers\.aspx`, `web\/invoices\.html`\./);
  assert.match(prompt, /`formatMoney` — 1 call site\(s\), all likely\n- `orders\/orders\.js:3` \(orders\)/);
});

test("the post-edit hook sees a script's globals: removing one that other blocks call warns, other edits stay quiet", () => {
  const root = copyFixture("scripts");
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  const file = path.join(root, "lib/format.js");
  const edit = () => handleHook("post-edit", { cwd: root, tool_name: "Edit", tool_input: { file_path: file } }, root);
  fs.appendFileSync(file, "\n// a comment\n");
  assert.equal(edit(), undefined, "an edit that keeps the globals says nothing");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("function formatMoney(cents)", "function formatCents(cents)"));
  assert.match(edit().hookSpecificOutput.additionalContext, /- formatMoney is no longer exported, but other blocks use it: orders\/orders\.js:3/);
});

test("analyze --json is complete when piped, even past 64 KB", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const result = spawnSync(process.execPath, [cli, "analyze", "--json", "-C", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.ok(result.stdout.length > 65536, "the output is large enough to have been cut before");
  assert.ok(JSON.parse(result.stdout).analysis.blocks.length > 0);
});

test("names like constructor or toString in scripts and imports are ordinary names", () => {
  const root = copyFixture("scripts");
  // A minified vendor script reading globals that share names with Object's own properties.
  fs.writeFileSync(path.join(root, "vendor.min.js"), "var a=constructor;toString();hasOwnProperty('x');valueOf;__proto__;\n");
  fs.writeFileSync(path.join(root, "proto.js"), "export function constructor() { return 1; }\n");
  fs.writeFileSync(path.join(root, "uses-proto.js"), 'import { toString } from "./other.js";\nimport { constructor } from "./proto.js";\nexport const made = constructor();\n');
  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(analysis.diagnostics.filter((diagnostic) => diagnostic.level === "error"), []);
  assert.ok(analysis.callSites.some((site) => site.symbol === "constructor" && site.file === "uses-proto.js"));
});

test("minified and bundled files are kept as files but not read, unless the map asks", () => {
  const root = copyFixture("scripts");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("plugins/chart.min.js", "function drawChart(a){return a}\n");
  write("plugins/long-lines.js", `function wide(){return 1}${";".repeat(30_000)}\n`);
  write("plugins/esm.min.js", "export function pick(a){return a}\n");
  write("reports/report.js", "function show() { return drawChart(1) + wide(); }\n");
  write("reports/uses-esm.mjs", 'import { pick } from "../plugins/esm.min.js";\nexport const chosen = pick(1);\n');
  write("reports/report.html", '<script src="../plugins/chart.min.js"></script>\n<script src="report.js"></script>\n');

  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(analysis.minifiedFiles.sort(), ["plugins/chart.min.js", "plugins/esm.min.js", "plugins/long-lines.js"]);
  assert.ok(analysis.fileTokens["plugins/chart.min.js"] > 0, "still counted in its block");
  const intoPlugins = analysis.callSites.filter((site) => site.targetFile.startsWith("plugins/"));
  assert.deepEqual(intoPlugins.map((site) => `${site.via} ${site.symbol}`), ["import pick"], "imports keep pointing to them; their globals, which need their code read, do not");
  assert.ok(analysis.pages.find((page) => page.file === "reports/report.html").scripts.includes("plugins/chart.min.js"), "<script src> still points to it");
  assert.ok(analysis.fileImports.some((edge) => edge.from === "reports/uses-esm.mjs" && edge.to === "plugins/esm.min.js"), "imports still point to it");
  assert.match(analysis.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /3 minified, bundled or third-party file\(s\) kept in their blocks but not analyzed/);

  const read = analyze(root, { skipGit: true, model: { version: 1, name: "s", blocks: [{ id: "all", name: "All", layer: "unassigned", include: ["."] }], dependencies: [], rules: { allow: {} }, analysis: { parseMinified: true } } });
  assert.deepEqual(read.minifiedFiles, []);
  assert.ok(read.callSites.some((site) => site.symbol === "drawChart"), "with parseMinified they are read");
});

test("third-party libraries with a license banner are not read either; the map can say what to read or skip", () => {
  const root = copyFixture("scripts");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("plugins/chart.js", "/*!\n * Chart.js v4.0.1\n * (c) 2022 Chart.js Contributors\n * Released under the MIT License\n */\nfunction Chart() {}\n");
  write("plugins/pdf.mjs", "/**\n * @licstart The following is the entire license notice\n */\nexport function getDocument() {}\n");
  write("app/header.js", "/* Copyright (c) 2020 Our Company. All rights reserved. */\nfunction ourHelper() {}\n");
  write("app/legacy-lib.js", "function oldLibrary() {}\n");
  write("app/meter.js", "function testSecurity() {}\n" + "/*zxcvbn*/" + "x".repeat(1100 * 1024) + "\n");

  const plain = analyze(root, { skipGit: true });
  assert.deepEqual(plain.minifiedFiles.sort(), ["app/meter.js", "plugins/chart.js", "plugins/pdf.mjs"], "banners with a version or a license marker; a company header is project code");

  const model = { version: 1, name: "s", blocks: [{ id: "all", name: "All", layer: "unassigned", include: ["."] }], dependencies: [], rules: { allow: {} }, analysis: { read: ["app/meter.js"], vendor: ["app/legacy-lib.js"] } };
  const listed = analyze(root, { skipGit: true, model });
  assert.deepEqual(listed.minifiedFiles.sort(), ["app/legacy-lib.js", "plugins/chart.js", "plugins/pdf.mjs"], "read wins over the heuristics, vendor adds to them");
  assert.ok(listed.catalog.some((entry) => entry.name === "testSecurity"), "the project code of a mixed file is read when the map asks");
});
