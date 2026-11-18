import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, buildContextPack, check, renderContextPrompt } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";
import { describeImpact } from "../dist/analysis/reach.js";
import { renderFindings } from "../dist/analysis/findings.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const modelOf = (ids) => ({ version: 1, name: "demo", blocks: ids.map((id) => ({ id, name: id, layer: "domain", include: [id] })), dependencies: [], rules: { allow: {} } });

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

/** core ← hub-a, hub-b ← twelve leaves: the leaves reach core only through the hubs. */
function hubProject() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-hubs-"));
  const files = { "package.json": '{"name":"hubs"}', "core/index.ts": "export const core = 1;\n", "hub-a/index.ts": 'import { core } from "../core";\nexport const a = core;\n', "hub-b/index.ts": 'import { core } from "../core";\nexport const b = core;\n' };
  for (let i = 0; i < 12; i++) {
    const hub = i < 8 ? "hub-a" : "hub-b";
    files[`leaf${String(i).padStart(2, "0")}/index.ts`] = `import { ${hub === "hub-a" ? "a" : "b"} } from "../${hub}";\nexport const v${i} = ${hub === "hub-a" ? "a" : "b"};\n`;
  }
  write(dir, files);
  return dir;
}

test("impact: the blocks reached only through others are counted by the hub they pass through", () => {
  const dir = hubProject();
  const analysis = analyze(dir, { skipGit: true, model: modelOf(fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory())) });
  const text = describeImpact(analysis, "core");
  assert.match(text, /14 of 14 other block\(s\) can be affected: 2 directly, 12 through others\./);
  assert.match(text, /## Through others: 12 block\(s\)/);
  assert.match(text, /- 8 via `hub-a`\n- 4 via `hub-b`/);
  assert.doesNotMatch(text, /leaf00/, "no chain per block by default");

  const full = describeImpact(analysis, "core", { full: true });
  assert.match(full, /`leaf00`, 2 steps: `leaf00` → `hub-a` → `core`/);
  assert.match(full, /`leaf11`, 2 steps/);

});

test("check: identical functions are one line per pair of files, contracts that need types one per kind", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-dups-"));
  const files = { "package.json": '{"name":"dups"}' };
  const body = (name, i) => `export function ${name}(values: number[]): number {\n  let total = 0;\n  for (const value of values) total += value * 2 + ${i};\n  return total;\n}\n`;
  for (let i = 0; i < 6; i++) {
    files["a/main.ts"] = (files["a/main.ts"] ?? "") + body(`sum${i}`, i);
    files["b/main.ts"] = (files["b/main.ts"] ?? "") + body(`sum${i}`, i);
  }
  write(dir, files);
  const model = modelOf(["a", "b"]);
  const analysis = analyze(dir, { skipGit: true, model });
  const findings = check(analysis, model);
  const duplicates = findings.filter((finding) => finding.kind === "duplicate-implementation");
  assert.equal(duplicates.length, 6);
  assert.deepEqual(duplicates[0].files, ["a/main.ts", "b/main.ts"]);

  const lines = renderFindings(findings, analysis);
  const grouped = lines.filter((line) => line.kind === "duplicate-implementation");
  assert.equal(grouped.length, 1);
  assert.match(grouped[0].message, /^`a\/main\.ts` ↔ `b\/main\.ts`: 6 identical function\(s\) \(sum0, sum1, sum2, sum3, sum4, sum5\)\.$/);
  assert.equal(renderFindings(findings, analysis, { full: true }).filter((line) => line.kind === "duplicate-implementation").length, 6);
  assert.equal(renderFindings(findings.slice(0, 2), analysis).length, 2, "a few are listed one by one");
});

test("check: contract findings are summarized per kind, a big cycle names the blocks that hold it", () => {
  const contract = (block, n) => ({ kind: "incomplete-contract", severity: "warning", message: `Contract of ${block}/f${n}.ts is incomplete: x`, blocks: [block], files: [`${block}/f${n}.ts`] });
  const findings = [contract("api", 1), contract("api", 2), contract("api", 3), contract("web", 4)];
  const lines = renderFindings(findings);
  assert.equal(lines.length, 1);
  assert.match(lines[0].message, /^4 public file\(s\) have incomplete contracts \(declarations need type inference\): api \(3\), web \(1\)\./);

  const blocks = Array.from({ length: 9 }, (_, i) => `b${i}`);
  const dependencies = [...blocks.slice(1).map((to) => ({ from: "b0", to, symbols: [], files: [], imports: [] })), { from: "b1", to: "b0", symbols: [], files: [], imports: [] }];
  const cycle = { kind: "cycle", severity: "warning", message: `Dependency cycle: ${blocks.join(" → ")} → b0`, blocks };
  const [line] = renderFindings([cycle], { dependencies });
  assert.match(line.message, /^Dependency cycle through 9 blocks: b0, b1, b2, b3, b4, b5, … 3 more\. Most connected inside it: b0 \(9 arrows\), b1 \(2 arrows\), b2 \(1 arrows\)/);
});

test("cantus check prints grouped lines and --full every finding", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-dups-"));
  const files = { "package.json": '{"name":"dups"}' };
  const body = (name, i) => `export function ${name}(values: number[]): number {\n  let total = 0;\n  for (const value of values) total += value * 2 + ${i};\n  return total;\n}\n`;
  for (let i = 0; i < 5; i++) {
    files["a/main.ts"] = (files["a/main.ts"] ?? "") + body(`sum${i}`, i);
    files["b/main.ts"] = (files["b/main.ts"] ?? "") + body(`sum${i}`, i);
  }
  write(dir, files);
  fs.mkdirSync(path.join(dir, ".cantus"));
  fs.writeFileSync(path.join(dir, ".cantus/model.json"), JSON.stringify(modelOf(["a", "b"])));
  const run = (...args) => spawnSync(process.execPath, [cli, "check", "-C", dir, ...args], { encoding: "utf8" });
  const short = run().stdout;
  assert.match(short, /\[duplicate-implementation\] `a\/main\.ts` ↔ `b\/main\.ts`: 5 identical function\(s\)/);
  assert.match(short, /5 finding\(s\) in 1 line\(s\); `cantus check --full` lists each one\./);
  const full = run("--full").stdout;
  assert.equal(full.match(/\[duplicate-implementation\]/g).length, 5);
});

test("a briefing says a big cycle in one line, and a small one in full", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  const analysis = analyze(root, { model, skipGit: true });
  const big = { kind: "cycle", severity: "warning", message: "Dependency cycle: a → b → c → d → e → f → g → a", blocks: ["src-checkout", "a", "b", "c", "d", "e", "f"] };
  const small = { kind: "cycle", severity: "warning", message: "Dependency cycle: src-checkout → src-orders → src-checkout", blocks: ["src-checkout", "src-orders"] };
  const text = renderContextPrompt(buildContextPack(analysis, "src-checkout", model, [big, small]), { root, inlineSources: false });
  assert.match(text, /- \[warning\] This block is in a dependency cycle through 7 blocks \(the `check` tool names them and the weakest arrow\)\./);
  assert.doesNotMatch(text, /a → b → c/);
  assert.match(text, /- \[warning\] Dependency cycle: src-checkout → src-orders → src-checkout/);
});
