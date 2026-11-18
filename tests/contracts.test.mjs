import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, check } from "../dist/index.js";
import { collectImports } from "../dist/analysis/imports.js";
import { findProjectCompiler, generateContracts, jsdocTypeToTs } from "../dist/analysis/contracts.js";
import { copyFixture, fixtures } from "./helpers.mjs";

const shop = path.join(fixtures, "shop");
const inferred = "export declare function discount(total: number): number;";

test("collects static, re-exported, dynamic and required imports", () => {
  const refs = collectImports(
    "a.ts",
    [
      'import D, { a as b, type T } from "./x.js";',
      'import * as NS from "ns";',
      'export { c } from "./c";',
      'export * from "./d";',
      'const lazy = import("./dyn");',
      'const old = require("./req");',
      "const computed = require(name);",
    ].join("\n"),
  );
  assert.deepEqual(refs, [
    { specifier: "./x.js", symbols: ["default", "a", "T"], bindings: [{ imported: "default", local: "D" }, { imported: "a", local: "b" }, { imported: "T", local: "T" }] },
    { specifier: "ns", symbols: ["*"], bindings: [{ imported: "*", local: "NS" }] },
    { specifier: "./c", symbols: ["c"], bindings: [] },
    { specifier: "./d", symbols: ["*"], bindings: [] },
    { specifier: "./dyn", symbols: ["*"], bindings: [] },
    { specifier: "./req", symbols: ["*"], bindings: [] },
  ]);
});

test("resolves tsconfig path aliases and relative imports to the same block", () => {
  const analysis = analyze(path.join(fixtures, "aliases"), { skipGit: true });
  assert.deepEqual(
    analysis.dependencies.map((dep) => `${dep.from}->${dep.to}:${dep.symbols.join(",")}`),
    ["src-app->src-lib:*,add"],
  );
  assert.deepEqual(analysis.unresolvedImports, []);
  assert.deepEqual(analysis.blocks.map((info) => info.externalPackages), [[], []]);
});

test("explicitly typed exports get contracts from oxc alone", () => {
  const { contracts, issues } = generateContracts(shop, ["src/checkout/index.ts", "src/orders/index.ts"], "none");
  assert.deepEqual(issues, []);
  assert.match(contracts["src/orders/index.ts"], /export declare function createOrder\(id: string, total: number\): Order;/);
});

test("inferred types fall back to the project's own compiler", () => {
  const compiler = findProjectCompiler(shop);
  assert.match(compiler.label, /^typescript@7\./, "the repo's TypeScript 7 is found by walking up from the fixture");
  const { contracts, issues } = generateContracts(shop, ["src/pricing/index.ts"], "project");
  assert.equal(issues[0].engine, "project-compiler");
  assert.match(issues[0].messages[0], /TS9007/);
  assert.match(contracts["src/pricing/index.ts"], new RegExp(inferred.replace(/[()]/g, "\\$&")));
});

test("without a project compiler, the bundled TypeScript 6 fills in", () => {
  const root = copyFixture("shop");
  assert.equal(findProjectCompiler(root), undefined);
  const analysis = analyze(root, { skipGit: true });
  const issue = analysis.contractIssues.find((candidate) => candidate.file === "src/pricing/index.ts");
  assert.equal(issue.engine, "typescript6");
  assert.match(issue.compiler, /^typescript@6\./);
  assert.ok(analysis.contracts["src/pricing/index.ts"].includes(inferred));

  const finding = check(analysis).find((candidate) => candidate.kind === "inferred-contract");
  assert.equal(finding.severity, "info");
  assert.deepEqual(finding.blocks, ["src-pricing"]);
});

test("with no compiler allowed, the contract is marked incomplete", () => {
  const analysis = analyze(shop, { skipGit: true, compilerFallback: "none" });
  assert.equal(analysis.contractIssues[0].engine, "incomplete");
  assert.match(analysis.contracts["src/pricing/index.ts"], /export declare function discount\(total: number\);/);
  const finding = check(analysis).find((candidate) => candidate.kind === "incomplete-contract");
  assert.equal(finding.severity, "warning");
  assert.match(finding.message, /Add explicit types/);
});

test("JSDoc-typed JavaScript exports become declarations without a compiler", () => {
  const jsdoc = path.join(fixtures, "jsdoc");
  const { contracts, issues } = generateContracts(jsdoc, ["src/api.js"], "none");
  assert.deepEqual(issues.map((issue) => issue.engine), ["jsdoc"]);
  assert.match(contracts["src/api.js"], /export declare function formatPrice\(value: number, currency\?: string\): string;/);
  assert.match(contracts["src/api.js"], /export declare const parseId: \(raw: string\) => number;/);
  assert.match(contracts["src/api.js"], /export declare const version/);
});

test("JavaScript exports without complete JSDoc tags are not covered by tags alone", () => {
  const jsdoc = path.join(fixtures, "jsdoc");
  const { contracts, issues } = generateContracts(jsdoc, ["src/partial.js"], "none");
  assert.deepEqual(issues.map((issue) => issue.engine), ["incomplete"]);
  assert.match(contracts["src/partial.js"], /untyped/);
});

test("JSDoc written for the Closure Compiler becomes TypeScript; declarations oxc made are kept whole", () => {
  const jsdoc = path.join(fixtures, "jsdoc");
  const { contracts, issues } = generateContracts(jsdoc, ["src/closure.js"], "none");
  assert.deepEqual(issues.map((issue) => issue.engine), ["jsdoc"]);
  const text = contracts["src/closure.js"];
  assert.match(text, /export declare const settings: \{\n\s+id: number;\n\s+label: string;\n\};/, "a multi-line declaration is kept whole");
  assert.match(
    text,
    /export declare function id\(keys: Array<string>, weights\?: Record<string, number>, accept: \(arg0: string, arg1\?: number\) => boolean, options\?: \{ id: number, tags: Array<string> \} \| null, \.\.\.extra: any\[\]\): \(string \| null\);/,
  );
  assert.equal((text.match(/declare function id/g) ?? []).length, 1);
});

test("Closure type expressions map to TypeScript", () => {
  assert.equal(jsdocTypeToTs("*"), "any");
  assert.equal(jsdocTypeToTs("?number"), "number | null");
  assert.equal(jsdocTypeToTs("!Element"), "Element");
  assert.equal(jsdocTypeToTs("Array.<Object.<string, ?Date>>"), "Array<Record<string, Date | null>>");
  assert.equal(jsdocTypeToTs("function(new:Foo, string)"), "(arg0: string) => void");
  assert.equal(jsdocTypeToTs("Promise<string[]>"), "Promise<string[]>", "TypeScript types pass through");
});

test("JSDoc types the catalog of files no other block imports", () => {
  const analysis = analyze(path.join(fixtures, "jsdoc"), { skipGit: true });
  const entry = analysis.catalog.find((candidate) => candidate.name === "formatPrice");
  assert.equal(entry.signature, "function formatPrice(value: number, currency?: string): string;");
  assert.equal(entry.complete, true);
});

// In a monorepo the path aliases live in the sub-project's tsconfig.json, not in the root one.
const monoAlias = path.join(fixtures, "mono-alias");
const monoModel = {
  version: 1,
  layers: ["application", "infrastructure"],
  blocks: [
    { id: "lib", name: "Lib", layer: "infrastructure", include: ["apps/mobile/src/lib"] },
    { id: "data", name: "Data", layer: "infrastructure", include: ["apps/mobile/src/data"] },
    { id: "screens", name: "Screens", layer: "application", include: ["apps/mobile/src/screens"] },
  ],
  dependencies: [],
};

test("contracts use the tsconfig closest to the file, so a sub-project's aliases resolve", () => {
  const { contracts } = generateContracts(monoAlias, ["apps/mobile/src/data/provider.ts"], "bundled");
  assert.match(contracts["apps/mobile/src/data/provider.ts"], /ok: boolean/, "the alias is followed: the type is not `any`");
  const compiler = generateContracts(monoAlias, ["apps/mobile/src/data/provider.ts"], "project");
  assert.match(compiler.contracts["apps/mobile/src/data/provider.ts"], /ok: boolean/);
});

test("the project compiler is not blamed for aliases it follows: no unresolved-import warnings", () => {
  const analysis = analyze(monoAlias, { model: monoModel, skipGit: true });
  const unresolved = analysis.diagnostics.filter((diagnostic) => /TS2307/.test(diagnostic.message));
  assert.deepEqual(unresolved, []);
  assert.match(analysis.contracts["apps/mobile/src/data/provider.ts"], /ok: boolean/);
});

test("a compiler complaint about an import the analysis resolved is left out; others are kept", () => {
  const file = "apps/mobile/src/data/legacy.ts";
  const run = (resolvedLocally) => {
    const diagnostics = [];
    generateContracts(monoAlias, [file], "project", (diagnostic) => diagnostics.push(diagnostic), new Map(), resolvedLocally);
    return diagnostics;
  };
  assert.ok(run(() => false).some((diagnostic) => diagnostic.file === file && /TS2307.*~\/lib\/report/.test(diagnostic.message)));
  const quiet = run((from, specifier) => from === file && specifier === "~/lib/report");
  assert.deepEqual(quiet.filter((diagnostic) => /TS2307/.test(diagnostic.message)), []);
  assert.match(quiet.find((diagnostic) => diagnostic.level === "info" && /reported 1 diagnostic/.test(diagnostic.message)).message, /1 about imports the analysis resolves itself/);
});

test("a compiler that breaks leaves its output in the log, and a file without declarations is one warning", () => {
  const root = copyFixture("mono-alias");
  const bin = path.join(root, "node_modules", "typescript", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "9.9.9", bin: { tsc: "./bin/tsc.js" } }));
  fs.writeFileSync(path.join(bin, "tsc.js"), 'console.error("Error: Cannot find module \'./lib/tsc.js\'");\nprocess.exit(1);\n');
  const diagnostics = [];
  const file = "apps/mobile/src/data/provider.ts";
  const { issues } = generateContracts(root, [file], "project", (diagnostic) => diagnostics.push(diagnostic));
  assert.equal(issues[0].engine, "incomplete");
  assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.level === "error"), [], "a contract that stays partial is not an analysis error");
  const crash = diagnostics.find((diagnostic) => /printed something other than type errors/.test(diagnostic.message));
  assert.match(crash.detail, /Cannot find module/);
  const partial = diagnostics.filter((diagnostic) => diagnostic.file === file && /no compiler could generate/.test(diagnostic.message));
  assert.equal(partial.length, 1);
  assert.match(partial[0].detail, /typescript@9\.9\.9 produced no declarations/);
});
