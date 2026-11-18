import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, findBreakingChanges, handleHook, renderContextPrompt, writeProjectIndex } from "../dist/index.js";
import { copyFixture } from "./helpers.mjs";

test("Go: files of a module are blocks by folder; _test.go files stay out; the module's last element names the project", () => {
  const analysis = analyze(copyFixture("golang"), { skipGit: true });
  assert.deepEqual(analysis.blocks.map((info) => `${info.block.id}: ${info.files.join(",")}`), [
    "cmd: cmd/main.go",
    "internal: internal/tui/window.go,internal/util/item.go,internal/util/strings.go",
  ]);
  assert.deepEqual(analysis.blocks[1].externalPackages, ["fmt", "os", "strings"], "the standard library is external");
});

test("Go: imports of the module's packages reach the file that declares each name used", () => {
  const analysis = analyze(copyFixture("golang"), { skipGit: true });
  assert.deepEqual(analysis.callSites.map((site) => `${site.file}:${site.line} ${site.symbol} → ${site.targetFile}`), [
    "cmd/main.go:10 Render → internal/tui/window.go",
    "cmd/main.go:9 Item → internal/util/item.go",
    "internal/tui/window.go:10 Item → internal/util/item.go",
    "internal/tui/window.go:11 Truncate → internal/util/strings.go",
    "internal/tui/window.go:11 Max → internal/util/item.go",
  ], "an aliased import (`helpers`) and a qualified type (`*helpers.Item`) count; a local named `util` after the import does not hide it");
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to} [${dep.symbols.join(",")}]`), ["cmd->internal [Item,Render]"]);
  assert.deepEqual(analysis.unresolvedImports, []);
});

test("Go: the catalog lists exported names, with exported fields and methods and the doc comment", () => {
  const analysis = analyze(copyFixture("golang"), { skipGit: true });
  const entries = analysis.catalog.filter((entry) => entry.file.startsWith("internal/util/"));
  assert.deepEqual(entries.map((entry) => `${entry.kind} ${entry.name}`), ["variable Debug", "class Item", "variable Max", "interface Reader", "function Truncate"]);
  const item = entries.find((entry) => entry.name === "Item");
  assert.equal(item.signature, "type Item struct {\n    Text string\n    func (item *Item) Len() int\n}", "the private field and method are not API");
  assert.equal(item.doc, "Item is one entry.");
  assert.equal(entries.find((entry) => entry.name === "Truncate").signature, "func Truncate(input string, limit int) (string, bool)");
});

test("Go: a changed signature warns callers in other blocks", () => {
  const root = copyFixture("golang");
  const before = analyze(root, { skipGit: true });
  writeProjectIndex(root, before);
  const file = path.join(root, "internal/util/item.go");
  const original = fs.readFileSync(file, "utf8");
  // Nobody calls Len: the callers of the type are not asked to check.
  fs.writeFileSync(file, original.replace("func (item *Item) Len() int", "func (item *Item) Len() int64"));
  assert.equal(handleHook("post-edit", { cwd: root, tool_name: "Edit", tool_input: { file_path: file } }, root), undefined);
  fs.writeFileSync(file, original.replace("Text  string", "Text  []byte"));
  const hook = handleHook("post-edit", { cwd: root, tool_name: "Edit", tool_input: { file_path: file } }, root);
  assert.match(hook.hookSpecificOutput.additionalContext, /- Item: changed: Text; other blocks use it here: cmd\/main\.go:9/);
  fs.writeFileSync(file, original.replace("func (item *Item) Len() int", "func (item *Item) Len() int64"));
  const findings = findBreakingChanges(before, analyze(root, { skipGit: true }), "internal");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^Item changed from /);
});

test("Go: a briefing shows the declarations of the packages it uses", () => {
  const root = copyFixture("golang");
  const analysis = analyze(root, { skipGit: true });
  const prompt = renderContextPrompt(buildContextPack(analysis, "cmd"), { root, inlineSources: false });
  assert.match(prompt, /```go\n\/\/ Item is one entry\.\ntype Item struct \{/);
});
