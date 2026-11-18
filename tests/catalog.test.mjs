import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildCatalog, buildContextPack, check, describeApiSearch, findNewDuplicates, renderContextPrompt, searchCatalog } from "../dist/index.js";
import { copyFixture, fixtures, shopModel } from "./helpers.mjs";

const shop = path.join(fixtures, "shop");

test("the catalog lists every export of every block with signature, doc and completeness", () => {
  const analysis = analyze(shop, { skipGit: true });
  const entry = (name) => analysis.catalog.find((candidate) => candidate.name === name);
  assert.deepEqual(
    [...new Set(analysis.catalog.map((candidate) => candidate.block))].sort(),
    ["src-checkout", "src-db", "src-orders", "src-payments", "src-pricing", "src-web"],
  );
  assert.equal(entry("createOrder").kind, "function");
  assert.equal(entry("Order").kind, "interface");
  assert.equal(entry("db").kind, "variable");
  assert.equal(entry("discount").signature, "function discount(total: number): number;", "inferred type completed by the compiler fallback");
  assert.equal(entry("discount").complete, true);
  assert.ok(entry("createOrder").bodyHash, "function bodies are fingerprinted");
});

test("doc comments are kept and searchable", () => {
  const root = copyFixture("shop");
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\n/** Formats an amount of money as a euro price string. */\nexport function formatMoney(amount: number): string {\n  return `€ ${amount.toFixed(2)}`;\n}\n");
  const analysis = analyze(root, { skipGit: true });
  const [best] = searchCatalog(analysis.catalog, "euro price");
  assert.equal(best.name, "formatMoney");
  assert.equal(best.doc, "Formats an amount of money as a euro price string.");
  assert.equal(searchCatalog(analysis.catalog, "createOrder")[0].name, "createOrder");
  assert.deepEqual(searchCatalog(analysis.catalog, "zzz"), []);
});

test("an agent sees the whole API of its neighbors, not only what it imports today", () => {
  const model = shopModel();
  const analysis = analyze(shop, { model, skipGit: true });
  const pack = buildContextPack(analysis, "src-checkout", model);
  const pricing = pack.neighbors.find((neighbor) => neighbor.block.id === "src-pricing");
  assert.deepEqual(pricing.symbols, ["quote"]);
  assert.ok(pricing.declarations.some((decl) => decl.text.includes("discount")), "discount is visible although checkout never imported it");

  const web = buildContextPack(analysis, "src-web", model);
  assert.deepEqual(web.otherBlocks.map((other) => other.block.id).sort(), ["src-orders", "src-payments", "src-pricing"], "db is a neighbor already: web imports it, which is the drift");
  const prompt = renderContextPrompt(web, { root: shop });
  assert.match(prompt, /## Other blocks/);
  assert.match(prompt, /Reuse before you write/);
});

test("find_api says whether a result is usable from the calling block", () => {
  const model = shopModel();
  const analysis = analyze(shop, { model, skipGit: true });
  const from = { id: "src-checkout", dependsOn: model.dependencies.filter((dep) => dep.from === "src-checkout").map((dep) => dep.to) };
  assert.match(describeApiSearch(analysis.catalog, "discount", from), /^\[already a dependency: src-pricing\] src\/pricing\/index\.ts: function discount\(total: number\): number;/);
  assert.match(describeApiSearch(analysis.catalog, "db log", from), /\[new dependency: src-db\]/);
  assert.match(describeApiSearch(analysis.catalog, "place order", from), /\[yours\] src\/checkout\/index\.ts/);
  assert.match(describeApiSearch(analysis.catalog, "place order"), /\[src-checkout\] src\/checkout\/index\.ts/);
  assert.match(describeApiSearch(analysis.catalog, "qqq", from), /Nothing to reuse/);
});

test("rewriting an existing function in another block is flagged", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  const before = analyze(root, { model, skipGit: true });
  fs.writeFileSync(
    path.join(root, "src/checkout/pricing-copy.ts"),
    "export function totalOf(items: Array<{ quantity: number; unitPrice: number }>): number {\n  return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);\n}\n\nexport function discount(total: number): number {\n  return total * 0.8;\n}\n",
  );
  const after = analyze(root, { model, skipGit: true });
  const findings = findNewDuplicates(before.catalog, after.catalog, "src-checkout");
  assert.deepEqual(
    findings.map((finding) => finding.message.replace(/\. Reuse.*/, "")).sort(),
    [
      "discount in src/checkout/pricing-copy.ts may duplicate discount in src/pricing/index.ts (src-pricing): same name",
      "totalOf in src/checkout/pricing-copy.ts may duplicate quote in src/pricing/index.ts (src-pricing): same implementation",
    ],
  );
  assert.ok(check(after, model).some((finding) => finding.kind === "duplicate-implementation"), "the static check also sees the copy");
  assert.deepEqual(findNewDuplicates(after.catalog, after.catalog, "src-checkout"), [], "unchanged code is not reported again");
});

test("search does not match a word on a two-letter part of a name", async () => {
  const { searchCatalog } = await import("../dist/analysis/catalog.js");
  const entry = (name) => ({ block: "b", file: "f.js", name, kind: "function", signature: `function ${name}();`, complete: false, shape: "" });
  assert.deepEqual(searchCatalog([entry("dataToSend"), entry("feedbackResultToast"), entry("toastQueue")], "toast").map((found) => found.name), ["feedbackResultToast", "toastQueue"]);
  assert.deepEqual(searchCatalog([entry("formatPrice")], "form").map((found) => found.name), ["formatPrice"], "a real prefix still counts");
});

test("search puts the type that carries the words in its name before one that only mentions them", async () => {
  const { searchCatalog, describeApiSearch } = await import("../dist/analysis/catalog.js");
  const entry = (name, kind, signature, extra = {}) => ({ block: "b", file: `${name}.cs`, name, kind, signature, complete: true, shape: "", ...extra });
  const catalog = [
    // A generic model that lists the words among its fields.
    entry("Documento", "class", "class Documento { fatture: string; cliente: string; emesse: string; id: number; }"),
    // The class the question is about: plural/singular differ.
    entry("FatturaController", "class", "class FatturaController { cliente: string; Emetti(importo: number): void; }"),
    entry("Util", "function", "function Util(): void;", { doc: "Cliente e fatture emesse." }),
  ];
  assert.equal(searchCatalog(catalog, "fatture cliente")[0].name, "FatturaController");
  const text = describeApiSearch(catalog, "fatture cliente");
  assert.match(text, /FatturaController.*\(matched: name fatture; member cliente\)/, "says which words matched where");
  assert.match(text, /Documento.*\(matched: member fatture cliente\)/);
  assert.match(text, /Util.*\(matched: doc fatture cliente\)/);
});

test("search ignores accents and does not repeat a word of the query", async () => {
  const { searchCatalog } = await import("../dist/analysis/catalog.js");
  const entry = (name, doc) => ({ block: "b", file: "f.js", name, kind: "function", signature: `function ${name}();`, doc, complete: false, shape: "" });
  assert.deepEqual(searchCatalog([entry("calcola", "Totale della città")], "citta città").map((found) => found.name), ["calcola"]);
});

test("catalog entries say on which line of the source an export is declared", () => {
  const entries = buildCatalog([{ file: "src/a.ts", block: "a", source: [
    "import x from './x';",
    "const hidden = 1;",
    "",
    "/** Doc. */",
    "export function first(a: number): number { return a; }",
    "function local(): string { return 'x'; }",
    "export const second = 2, third = 3;",
    "export { local as renamed };",
    "export interface Shape { w: number }",
    "export default class Thing {}",
  ].join("\n") }], {}, new Set());
  const lines = Object.fromEntries(entries.map((entry) => [entry.name, entry.line]));
  assert.deepEqual(lines, { first: 5, second: 7, third: 7, Shape: 9, default: 10 });
});

test("the little words of a sentence do not drown the search", () => {
  const catalog = [
    { name: "sendObjDati", kind: "function", signature: "function sendObjDati(url, obj)", file: "a.js", block: "a", doc: "Invio dati al server" },
    { name: "Fattura", kind: "class", signature: "class Fattura { dati: string; al: number }", file: "b.cs", block: "b", doc: "Dati con metodo al cliente" },
  ];
  assert.deepEqual(searchCatalog(catalog, "send al con").map((entry) => entry.name), ["sendObjDati"], "al and con count for nothing");
  assert.equal(searchCatalog(catalog, "al con di").length > 0, true, "a query of only little words still searches, rather than finding nothing");
});
