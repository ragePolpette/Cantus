import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { analyze, check } from "../dist/index.js";
import { renderFindings } from "../dist/analysis/findings.js";
import { fixtures } from "./helpers.mjs";

const shop = path.join(fixtures, "shop");

// The readers of other languages run in a worker whose failures are only diagnostics: these checks inject them.
function withDiagnostics(...diagnostics) {
  const analysis = analyze(shop, { skipGit: true });
  analysis.diagnostics.push(...diagnostics);
  return analysis;
}

test("files a reader could not read are a finding on their block, not a silent hole in the map", () => {
  const analysis = withDiagnostics(
    { level: "warning", stage: "parse", file: "src/orders/index.ts", message: "cannot parse Python: out of memory" },
    { level: "warning", stage: "parse", file: "src/orders/other.ts", message: "cannot parse Python: out of memory" },
  );
  const found = check(analysis).filter((finding) => finding.kind === "unreadable-files");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.deepEqual(found[0].blocks, ["src-orders"]);
  assert.deepEqual(found[0].files, ["src/orders/index.ts", "src/orders/other.ts"]);
  assert.match(found[0].message, /2 file\(s\) could not be read \(`src\/orders\/index\.ts`, `src\/orders\/other\.ts`\): cannot parse Python: out of memory/);
  assert.match(found[0].message, /no imports, exports or endpoints/);
  assert.match(found[0].message, /report it as a Cantus bug/);
});

test("a missing grammar says to reinstall, not to report the code", () => {
  const analysis = withDiagnostics({ level: "warning", stage: "parse", file: "src/orders/index.ts", message: "cannot parse Python: ENOENT: no such file or directory, open '/x/grammars/tree-sitter-python.wasm'" });
  const finding = check(analysis).find((candidate) => candidate.kind === "unreadable-files");
  assert.match(finding.message, /reinstall Cantus/);
  assert.doesNotMatch(finding.message, /Cantus bug/);
});

test("a reader that failed as a whole is an error naming the affected blocks", () => {
  const analysis = withDiagnostics({ level: "error", stage: "parse", message: "the tree-sitter reader failed: spawn ENOMEM" });
  const finding = check(analysis).find((candidate) => candidate.kind === "unreadable-files");
  assert.equal(finding.severity, "error");
  assert.match(finding.message, /tree-sitter reader failed \(spawn ENOMEM\)/);
  assert.match(finding.message, /installation problem/);
  assert.deepEqual(finding.blocks, [], "the shop has no files in the languages that reader handles");
});

test("syntax errors and notes are not unreadable files", () => {
  const analysis = withDiagnostics(
    { level: "error", stage: "parse", file: "src/orders/index.ts", message: "Unexpected token" },
    { level: "info", stage: "parse", file: "src/orders/index.ts", message: "cannot parse something" },
  );
  assert.equal(check(analysis).some((finding) => finding.kind === "unreadable-files"), false);
});

test("the finding is shown by the check lines", () => {
  const analysis = withDiagnostics({ level: "warning", stage: "parse", file: "src/orders/index.ts", message: "cannot parse Go: boom" });
  const lines = renderFindings(check(analysis), analysis);
  assert.ok(lines.some((line) => /unreadable-files|could not be read/.test(JSON.stringify(line))));
});
