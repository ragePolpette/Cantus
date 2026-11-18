import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, buildContextPack, findBreakingChanges, renderContextPrompt } from "../dist/index.js";
import { analyzeModule } from "../dist/analysis/imports.js";
import { copyFixture, fixtures, shopModel } from "./helpers.mjs";

const shop = path.join(fixtures, "shop");
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

test("usages of imported bindings are found with line, column and snippet", () => {
  const source = [
    'import { fmt, type Money } from "./a";',
    'import * as db from "./db";',
    'import Widget from "./widget";',
    "const total: Money = fmt(1);",
    "const config = { fmt: 1, other: fmt };",
    "class View { fmt() { return db.query(\"x\"); } }",
    "const node = <Widget label={fmt(2)} />;",
    "export { fmt };",
    'export { fmt as again } from "./a";',
    "export { fmt as format };",
  ].join("\n");
  const { usages } = analyzeModule("x.tsx", source);
  assert.deepEqual(
    usages.fmt.map((usage) => [usage.line, usage.column]),
    [[4, 22], [5, 33], [7, 29], [8, 10], [10, 10]],
    "count local bindings in exports and skip direct re-exports",
  );
  assert.deepEqual(usages.Money.map((usage) => [usage.line, usage.column]), [[4, 14]]);
  assert.deepEqual(usages.db.map((usage) => usage.member), ["query"]);
  assert.deepEqual(usages.Widget.map((usage) => usage.line), [7]);
  assert.equal(usages.fmt[0].snippet, "const total: Money = fmt(1);");
});

test("a block's context lists where other blocks call its API", () => {
  const model = shopModel();
  const analysis = analyze(shop, { model, skipGit: true });
  const pack = buildContextPack(analysis, "src-db", model);
  assert.deepEqual(pack.callers.map((site) => `${site.file}:${site.line}`), ["src/orders/index.ts:10", "src/web/checkout-page.ts:6"]);
  const prompt = renderContextPrompt(pack, { root: shop });
  assert.match(prompt, /## Callers of your API/);
  assert.match(prompt, /`db` — 2 call site\(s\)/);
  assert.match(prompt, /- `src\/web\/checkout-page\.ts:6` \(src-web\): `db\.log\("checkout rendered"\);`/);
  assert.equal(buildContextPack(analysis, "src-web", model).callers.length, 0);
});

test("changing or removing an API that other blocks call is reported with the call sites", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  const before = analyze(root, { model, skipGit: true });

  fs.writeFileSync(path.join(root, "src/orders/index.ts"), 'export interface Order { id: string; total: number }\nexport function createOrder(id: string, total: number, currency: string): Order {\n  return { id, total };\n}\n');
  const changed = findBreakingChanges(before, analyze(root, { model, skipGit: true }), "src-orders");
  assert.equal(changed.length, 1);
  assert.match(changed[0].message, /createOrder changed from `function createOrder\(id: string, total: number\): Order;` to `function createOrder\(id: string, total: number, currency: string\): Order;`; callers in other blocks: src\/checkout\/index\.ts:11/);
  assert.deepEqual(changed[0].blocks, ["src-orders", "src-checkout"]);

  fs.writeFileSync(path.join(root, "src/pricing/index.ts"), "export const nothing: number = 0;\n");
  const removed = findBreakingChanges(before, analyze(root, { model, skipGit: true }), "src-pricing");
  assert.match(removed[0].message, /quote was removed from src\/pricing\/index\.ts; callers in other blocks: src\/checkout\/index\.ts:9/);

  assert.deepEqual(findBreakingChanges(before, before, "src-orders"), [], "no change, no finding");
});

test("check passes on code ahead of the map, and fails on it with --strict", () => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel()));
  const run = (...args) => spawnSync(process.execPath, [cli, "check", "-C", root, ...args], { encoding: "utf8" });
  const relaxed = run();
  assert.equal(relaxed.status, 0);
  assert.match(relaxed.stdout, /Not on the map yet: Web imports Database/);
  const strict = run("--strict");
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /which the map does not allow/);
});

test("call sites say how they were found and how sure the link is", async () => {
  const { renderCallers } = await import("../dist/context/index.js");
  const shop = analyze(copyFixture("shop"), { model: shopModel(), skipGit: true });
  assert.ok(shop.callSites.length > 0 && shop.callSites.every((site) => site.via === "import" && site.match === "certain"));

  const root = copyFixture("scripts");
  // A script no page loads, calling a global two files define: the name is all there is.
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports/report.js"), "function printReport(x) { return formatLabel(x); }\n");
  const analysis = analyze(root, { skipGit: true });
  const sites = analysis.callSites.filter((site) => site.symbol === "formatLabel");
  assert.deepEqual(sites.map((site) => `${site.file}→${site.targetFile} ${site.via} ${site.match}`).sort(), [
    "customers/page.js→customers/helpers.js global likely",
    "invoices/page.js→invoices/helpers.js global likely",
    "reports/report.js→customers/helpers.js global by-name",
    "reports/report.js→invoices/helpers.js global by-name",
  ]);
  const text = renderCallers(sites.filter((site) => site.targetFile === "customers/helpers.js")).join("\n");
  assert.match(text, /`formatLabel` — 2 call site\(s\), 1 found by name only/);
  assert.match(text, /customers\/page\.js:\d+` \(customers\): `[^`]+` \(likely\)\n- `reports\/report\.js:1` \([^)]+\): `[^`]+` \(by name only\)/, "surest first, each marked");

  const csharp = analyze(copyFixture("csharp"), { skipGit: true });
  assert.ok(csharp.callSites.filter((site) => site.via === "http").every((site) => site.match === "likely"));
  assert.deepEqual(csharp.callSites.filter((site) => site.via === "type").map((site) => `${site.file}:${site.line} ${site.symbol} → ${site.targetFile} ${site.match}`), [
    "Services/Catalog.svc.cs:3 ICatalog → Services/ICatalog.cs likely",
  ], "a C# type used by name, found in a namespace the file sees");
});

test("by-name callers: a local definition wins, declarations beat window assignments, one line per call", async () => {
  const { renderCallers } = await import("../dist/context/index.js");
  const root = copyFixture("scripts");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  // The report's cases: a component registered in the file that uses it, and in another one too.
  write("ui/list.js", 'Vue.component("sort-arrows", { template: "<span></span>" });\nnew Vue({ template: "<div><sort-arrows></sort-arrows></div>" });\n');
  write("ui/other.js", 'Vue.component("sort-arrows", { template: "<i></i>" });\n');
  // A function declared in one file, re-exposed with window.x = … in another.
  write("ui/toast.js", "function showToast(text) { return text; }\n");
  write("ui/settings.js", "var panel = { show: function () {} };\nwindow.showToast = panel.show;\n");
  write("ui/account.js", 'function save() { showToast("saved"); }\n');
  // A helper defined twice: one call, two candidates.
  write("ui/a.js", "function pad(x) { return x; }\n");
  write("ui/b.js", "function pad(x) { return x; }\n");
  write("ui/use-pad.js", "function go() { return pad(1); }\n");

  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(analysis.callSites.filter((site) => site.symbol === "<sort-arrows>"), [], "the tag uses the component its own file defines");
  assert.deepEqual(analysis.callSites.filter((site) => site.symbol === "showToast").map((site) => `${site.file}→${site.targetFile} ${site.match}`), ["ui/account.js→ui/toast.js likely"]);
  const pad = analysis.callSites.filter((site) => site.symbol === "pad");
  assert.equal(pad.length, 2, "linked to both definitions");
  const text = renderCallers(pad).join("\n");
  assert.match(text, /`pad` — 1 call site\(s\), 1 found by name only/);
  assert.match(text, /- `ui\/use-pad\.js:1` \([^)]*\): `[^`]+`; 1 other definition\(s\) could answer it too/);
  assert.equal(text.match(/use-pad\.js:1/g).length, 1, "one line per call");
});

test("with no page to decide, the definition in the closest folder wins; a tie keeps them all", () => {
  const root = copyFixture("scripts");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  for (const file of ["Fhff/js/main.js", "js/main.js", "js/funzioniComode.js"]) write(file, "function senObjDati(url) { return url; }\n");
  write("Fhff/anagrafiche/info.js", 'function load() { return senObjDati("x"); }\n');
  write("other/page.js", 'function load2() { return senObjDati("y"); }\n');
  const analysis = analyze(root, { skipGit: true });
  const sites = (file) => analysis.callSites.filter((site) => site.symbol === "senObjDati" && site.file === file).map((site) => `${site.targetFile} ${site.match}`).sort();
  assert.deepEqual(sites("Fhff/anagrafiche/info.js"), ["Fhff/js/main.js by-name"]);
  assert.deepEqual(sites("other/page.js"), ["Fhff/js/main.js by-name", "js/funzioniComode.js by-name", "js/main.js by-name"]);
});
