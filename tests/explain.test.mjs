import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, buildViewData } from "../dist/index.js";
import { EXPLANATIONS, actionableItems, explainDiagnostics, renderProblems } from "../dist/analysis/explain.js";
import { fixtures } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const d = (level, stage, message, extra = {}) => ({ level, stage, message, ...extra });
const codes = (groups) => groups.map((group) => `${group.code}:${group.who}:${group.items.length}`);

test("a file whose declarations a compiler error blocks is one item, with that error's place", () => {
  const groups = explainDiagnostics([
    d("warning", "contracts", "no compiler could generate complete declarations; the contract is partial", { file: "app/i18n.ts", detail: "typescript@6.0.3 produced no declarations for this file" }),
    d("warning", "contracts", "typescript@6.0.3 TS2883: The inferred type of 'i18n' cannot be named.", { file: "app/i18n.ts", line: 8, column: 7 }),
    d("warning", "contracts", "TypeScript 6 TS2883: The inferred type of 'i18n' cannot be named.", { file: "app/i18n.ts", line: 8, column: 7 }),
  ]);
  assert.deepEqual(codes(groups), ["declarations-blocked:yours:1"]);
  const item = groups[0].items[0];
  assert.deepEqual([item.file, item.line, item.column], ["app/i18n.ts", 8, 7]);
  assert.equal(item.text, "TS2883: The inferred type of 'i18n' cannot be named.");
  assert.match(item.detail, /produced no declarations/);
});

test("unresolved imports split into packages to install and paths to fix, whichever stage found them", () => {
  const groups = explainDiagnostics([
    d("warning", "contracts", "typescript@5.9.3 TS2307: Cannot find module 'react-i18next' or its corresponding type declarations.", { file: "a.ts", line: 2, column: 3 }),
    d("warning", "contracts", "typescript@5.9.3 TS2307: Cannot find module '@/lib/x' or its corresponding type declarations.", { file: "a.ts", line: 1, column: 3 }),
    d("warning", "resolve", 'cannot resolve "@scope/pkg": not found', { file: "b.ts" }),
    d("warning", "resolve", 'cannot resolve "./gone": not found', { file: "b.ts" }),
  ]);
  assert.deepEqual(codes(groups), ["unresolved-path:yours:2", "missing-package:setup:2"]);
  assert.deepEqual(groups[0].items.map((item) => item.specifier), ["@/lib/x", "./gone"]);
});

test("type errors from the compiler are Cantus's limits, configuration errors and failing tools are the setup's", () => {
  const groups = explainDiagnostics([
    d("warning", "contracts", "typescript@6.0.3 TS7006: Parameter 'p' implicitly has an 'any' type.", { file: "a.ts", line: 1 }),
    d("warning", "contracts", "typescript@7.0.2 TS5102: Option 'baseUrl' has been removed.", {}),
    d("error", "parse", "the tree-sitter reader failed: spawn ENOMEM"),
    d("warning", "parse", "cannot parse Go: boom", { file: "a.go" }),
    d("warning", "git", "something odd"),
  ]);
  assert.deepEqual(codes(groups), ["tsconfig:setup:1", "tool-failed:setup:2", "other:setup:1", "compiler-types:cantus:1"]);
  assert.equal(groups.find((group) => group.code === "tool-failed").severity, "error");
  assert.equal(actionableItems(groups).length, 4);
});

test("code that does not parse is yours, once even if two stages saw it", () => {
  const analysis = analyze(path.join(fixtures, "broken"), { skipGit: true });
  const syntax = explainDiagnostics(analysis.diagnostics).find((group) => group.code === "syntax-error");
  assert.equal(syntax.who, "yours");
  assert.equal(syntax.severity, "error");
  const rules = syntax.items.filter((item) => item.file === "src/core/rules.ts");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].line, 5);
});

test("the text for a terminal lists each cause with what to do, and only counts Cantus's limits", () => {
  const text = renderProblems(
    explainDiagnostics([
      d("error", "parse", "Unexpected token", { file: "src/a.ts", line: 4, column: 2 }),
      d("warning", "contracts", "typescript@6.0.3 TS7006: Parameter 'p' implicitly has an 'any' type.", { file: "src/b.ts", line: 1 }),
    ]),
  );
  assert.match(text, /To fix in your code: Code that cannot be parsed \(1\)\n {2}- src\/a\.ts:4:2 {2}Unexpected token\n {2}What to do: Fix the syntax/);
  assert.match(text, /1 compiler note\(s\) about the code's types are not shown/);
  assert.doesNotMatch(text, /TS7006/);
});

test("a block is flagged by problems somebody can act on, not by the compiler's own type errors", () => {
  const analysis = analyze(path.join(fixtures, "shop"), { skipGit: true });
  analysis.diagnostics.push(d("warning", "contracts", "typescript@6.0.3 TS7006: Parameter 'p' implicitly has an 'any' type.", { file: "src/orders/index.ts", line: 1 }));
  let data = buildViewData(analysis, undefined, []);
  const orders = () => data.blocks.find((block) => block.id === "src-orders");
  assert.equal(orders().problems, 0);
  assert.notEqual(orders().severity, "error");
  assert.deepEqual(data.problems.map((group) => group.code), ["compiler-types"]);
  analysis.diagnostics.push(d("error", "parse", "Unexpected token", { file: "src/orders/index.ts", line: 3, column: 1 }));
  data = buildViewData(analysis, undefined, []);
  assert.equal(orders().problems, 1);
  assert.equal(orders().severity, "error");
});

test("check names the problems and what to do, not only a count", () => {
  const result = spawnSync(process.execPath, [cli, "check"], { encoding: "utf8", cwd: path.join(fixtures, "broken") });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Problems while reading the project:\nTo fix in your code: Code that cannot be parsed/);
  assert.match(result.stdout, /What to do: Fix the syntax/);
});

test("every kind of problem has who, a title, why and what to do", () => {
  for (const [code, text] of Object.entries(EXPLANATIONS)) {
    assert.ok(["yours", "setup", "cantus"].includes(text.who), code);
    for (const field of [text.title, text.why, text.action]) assert.ok(field.length > 10, code);
  }
});
