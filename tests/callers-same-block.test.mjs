import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, findCallers, handleHook, writeProjectIndex } from "../dist/index.js";

/** `lib` has two files, `util.ts` (exports `slug`) and `page.ts` (uses it); `app` uses it from another block. */
function project() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-same-block-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"demo"}\n');
  write("lib/util.ts", "export function slug(text: string): string {\n  return text.trim();\n}\n");
  write("lib/page.ts", 'import { slug } from "./util";\nexport const title = slug("a");\n');
  write("app/main.ts", 'import { slug } from "../lib/util";\nexport const id = slug("b");\n');
  return root;
}

const savedMap = {
  version: 1,
  name: "demo",
  blocks: [
    { id: "lib", name: "Lib", layer: "domain", include: ["lib"] },
    { id: "app", name: "App", layer: "interface", include: ["app"] },
  ],
  dependencies: [{ from: "app", to: "lib" }],
};

test("with a saved map, callers inside the block are left out and the answer says how many", () => {
  const analysis = analyze(project(), { model: savedMap, skipGit: true });
  const answer = findCallers(analysis, { symbol: "slug" });
  assert.deepEqual(answer.sites.map((site) => site.file), ["app/main.ts"]);
  assert.equal(answer.notes.length, 1);
  assert.match(answer.notes[0], /1 more call site\(s\) inside the block itself are not listed/);
  assert.match(answer.notes[0], /include_same_block/);

  const all = findCallers(analysis, { symbol: "slug", includeSameBlock: true });
  assert.deepEqual(all.sites.map((site) => site.file).sort(), ["app/main.ts", "lib/page.ts"]);
  assert.deepEqual(all.notes, [], "nothing left out, nothing to say");
});

test("with the blocks inferred from folders, callers in the same block are listed", () => {
  const analysis = analyze(project(), { skipGit: true });
  assert.equal(analysis.blocksInferred, true);
  const answer = findCallers(analysis, { symbol: "slug" });
  assert.deepEqual(answer.sites.map((site) => site.file).sort(), ["app/main.ts", "lib/page.ts"]);
  assert.deepEqual(answer.notes, []);
  const narrowed = findCallers(analysis, { symbol: "slug", includeSameBlock: false });
  assert.deepEqual(narrowed.sites.map((site) => site.file), ["app/main.ts"], "asking for the old behavior still works");
  assert.match(narrowed.notes[0], /1 more call site/);
});

test("a filter by file does not count what it filtered out as left out", () => {
  const analysis = analyze(project(), { model: savedMap, skipGit: true });
  const answer = findCallers(analysis, { symbol: "slug", file: "lib/other.ts" });
  assert.deepEqual(answer.sites, []);
  assert.ok(!answer.notes.some((note) => /more call site/.test(note)));
});

test("the hook before an edit lists every caller when the blocks are inferred, and counts the rest when they are saved", () => {
  const inferredRoot = project();
  writeProjectIndex(inferredRoot, analyze(inferredRoot, { skipGit: true }));
  const edit = (root) => handleHook("pre-edit", { tool_input: { file_path: path.join(root, "lib/util.ts") }, cwd: root }, root)?.hookSpecificOutput.additionalContext ?? "";
  const inferred = edit(inferredRoot);
  assert.match(inferred, /lib\/page\.ts:2/);
  assert.match(inferred, /app\/main\.ts:2/);

  const savedRoot = project();
  const model = savedMap;
  writeProjectIndex(savedRoot, analyze(savedRoot, { model, skipGit: true }), model);
  const saved = edit(savedRoot);
  assert.match(saved, /app\/main\.ts:2/);
  assert.doesNotMatch(saved, /lib\/page\.ts/);
  assert.match(saved, /1 call site\(s\) in other files of this block, not listed/);
});

test("the hook after an edit reports a broken caller in the same block when the blocks are inferred", () => {
  const root = project();
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  fs.writeFileSync(path.join(root, "lib/util.ts"), "export function slug(text: string, sep: string): string {\n  return text + sep;\n}\n");
  const after = handleHook("post-edit", { tool_input: { file_path: path.join(root, "lib/util.ts") }, cwd: root }, root)?.hookSpecificOutput.additionalContext ?? "";
  assert.match(after, /slug changed its declaration/);
  assert.match(after, /lib\/page\.ts:2/);
});

test("the diff counts a caller in the same block when the blocks are inferred, and says so", async () => {
  const { compareAnalyses, renderDelta } = await import("../dist/index.js");
  const root = project();
  const side = (label) => ({ label, analysis: analyze(root, { skipGit: true }), findings: [], read: (file) => fs.readFileSync(path.join(root, file), "utf8") });
  const base = side("base");
  fs.writeFileSync(path.join(root, "lib/util.ts"), "export function slug(text: string, sep: string): string {\n  return text + sep;\n}\n");
  const delta = compareAnalyses(base, side("head"));
  assert.equal(delta.inferred, true);
  const change = delta.exports.changed.find((entry) => entry.name === "slug");
  assert.deepEqual(change.callers.map((caller) => caller.file).sort(), ["app/main.ts", "lib/page.ts"]);
  const text = renderDelta(delta);
  assert.match(text, /2 use\(s\) in other files/);
  assert.doesNotMatch(text, /in other blocks/);
});
