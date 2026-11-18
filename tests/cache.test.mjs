import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const comparable = (analysis) => ({ ...analysis, timings: undefined });

test("a second analysis reuses the first for unchanged files, and gives the same result", () => {
  const root = copyFixture("shop");
  // Something to report, so the cached diagnostics are checked too.
  fs.appendFileSync(path.join(root, "src/web/checkout-page.ts"), 'import { gone } from "./missing.js";\nexport const g = gone;\n');
  const first = analyze(root, { model: shopModel(), skipGit: true });
  assert.ok(fs.existsSync(path.join(root, ".cantus/cache/analysis.json")));
  const second = analyze(root, { model: shopModel(), skipGit: true });
  assert.deepEqual(comparable(second), comparable(first));
  assert.ok(second.diagnostics.some((diagnostic) => /cannot resolve "\.\/missing\.js"/.test(diagnostic.message)), "diagnostics come back with the cached result");
});

test("a changed file is read again, and so are contracts and catalog", () => {
  const root = copyFixture("shop");
  analyze(root, { model: shopModel(), skipGit: true });
  const file = path.join(root, "src/pricing/index.ts");
  fs.appendFileSync(file, "export function roundCents(value: number): number {\n  return Math.round(value);\n}\n");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const after = analyze(root, { model: shopModel(), skipGit: true });
  assert.ok(after.catalog.some((entry) => entry.name === "roundCents"));
  assert.match(after.contracts["src/pricing/index.ts"], /roundCents/);
  // Moving a file to another block changes the catalog's block even if no file changed.
  const moved = { ...shopModel(), blocks: shopModel().blocks.map((block) => (block.id === "src-pricing" ? { ...block, id: "src-prices" } : block)) };
  assert.ok(analyze(root, { model: moved, skipGit: true }).catalog.some((entry) => entry.block === "src-prices"));
});

test("cache: false reads everything and writes nothing", () => {
  const root = copyFixture("shop");
  analyze(root, { model: shopModel(), skipGit: true, cache: false });
  assert.ok(!fs.existsSync(path.join(root, ".cantus/cache/analysis.json")));
});

test("contracts are regenerated for a changed file and for the files importing it, the rest reused", () => {
  const root = copyFixture("shop");
  fs.writeFileSync(path.join(root, "src/pricing/base.ts"), "export function base() {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(root, "src/pricing/index.ts"), 'import { base } from "./base.js";\nexport function wrap() {\n  return base();\n}\n');
  // checkout imports pricing, so pricing's files are public and get contracts.
  const first = analyze(root, { model: shopModel(), skipGit: true });
  assert.match(first.contracts["src/pricing/index.ts"], /wrap\(\): number/);
  const base = path.join(root, "src/pricing/base.ts");
  fs.writeFileSync(base, 'export function base() {\n  return "one";\n}\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(base, later, later);
  const second = analyze(root, { model: shopModel(), skipGit: true });
  assert.match(second.contracts["src/pricing/index.ts"], /wrap\(\): string/, "the importer's inferred type follows the file it imports");
  assert.equal(second.contracts["src/orders/index.ts"], first.contracts["src/orders/index.ts"]);
});
