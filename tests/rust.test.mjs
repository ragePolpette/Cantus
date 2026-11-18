import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, findBreakingChanges, handleHook, renderContextPrompt, writeProjectIndex } from "../dist/index.js";
import { copyFixture } from "./helpers.mjs";

test("Rust: each crate of the workspace is a block named after its package", () => {
  const analysis = analyze(copyFixture("rust"), { skipGit: true });
  assert.deepEqual(analysis.blocks.map((info) => `${info.block.id}: ${info.files.join(",")}`), [
    "crates-app: crates/app/src/main.rs",
    "crates-matcher: crates/matcher/src/interpolate.rs,crates/matcher/src/lib.rs",
    "crates-searcher: crates/searcher/src/lib.rs,crates/searcher/src/sink/lines.rs,crates/searcher/src/sink/mod.rs",
  ]);
  assert.deepEqual(analysis.blocks[0].externalPackages, ["std"]);
});

test("Rust: use paths reach the declaring file through crate, self, super, mod x; renamed dependencies and pub use", () => {
  const analysis = analyze(copyFixture("rust"), { skipGit: true });
  assert.deepEqual(analysis.callSites.map((site) => `${site.file}:${site.line} ${site.symbol} → ${site.targetFile}`).sort(), [
    "crates/app/src/main.rs:10 Match → crates/matcher/src/lib.rs",
    "crates/app/src/main.rs:15 Searcher → crates/searcher/src/lib.rs",
    "crates/app/src/main.rs:17 MAX_MATCHES → crates/matcher/src/lib.rs",
    "crates/app/src/main.rs:17 interpolate → crates/matcher/src/interpolate.rs",
    "crates/app/src/main.rs:8 Matcher → crates/matcher/src/lib.rs",
    "crates/app/src/main.rs:9 Match → crates/matcher/src/lib.rs",
    "crates/searcher/src/lib.rs:17 Match → crates/matcher/src/lib.rs",
    "crates/searcher/src/lib.rs:17 Matcher → crates/matcher/src/lib.rs",
    "crates/searcher/src/sink/lines.rs:4 Match → crates/matcher/src/lib.rs",
    "crates/searcher/src/sink/mod.rs:7 Lines → crates/searcher/src/sink/lines.rs",
    "crates/searcher/src/sink/mod.rs:7 Searcher → crates/searcher/src/lib.rs",
  ], "`Match as Hit` is still Match; `shop_searcher::reexported::MAX_MATCHES` goes through `pub use matcher as reexported` to the matcher crate; `interpolate` is the function, not the module of the same name");
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to} [${dep.symbols.join(",")}]`), [
    "crates-app->crates-matcher [MAX_MATCHES,Match,Matcher,interpolate]",
    "crates-app->crates-searcher [Searcher,Sink]",
    "crates-searcher->crates-matcher [*,Match,Matcher]",
  ]);
  assert.deepEqual(analysis.unresolvedImports, []);
});

test("Rust: the catalog lists pub items with their public fields, inherent methods and docs; tests and private items stay out", () => {
  const analysis = analyze(copyFixture("rust"), { skipGit: true });
  const entries = analysis.catalog.filter((entry) => entry.block === "crates-matcher");
  assert.deepEqual(entries.map((entry) => `${entry.kind} ${entry.name}`), ["function interpolate", "class Match", "interface Matcher", "variable MAX_MATCHES"]);
  const match = entries.find((entry) => entry.name === "Match");
  assert.equal(match.signature, "pub struct Match {\n    pub start: usize,\n    pub fn new(start: usize, end: usize) -> Match;\n    pub fn len(&self) -> usize;\n}", "the private field `end` and the private method `check` are not API");
  assert.equal(match.doc, "A match: a range of bytes.");
  assert.equal(entries.find((entry) => entry.name === "Matcher").signature, "pub trait Matcher {\n    fn find(&self, haystack: &[u8]) -> Option<Match>;\n}");
  assert.equal(entries.find((entry) => entry.name === "interpolate").signature, "pub fn interpolate(template: &str, name: &str) -> String");
});

test("Rust: a changed signature is a breaking change, and the hook warns", () => {
  const root = copyFixture("rust");
  const before = analyze(root, { skipGit: true });
  writeProjectIndex(root, before);
  const lib = path.join(root, "crates/matcher/src/lib.rs");
  fs.writeFileSync(lib, fs.readFileSync(lib, "utf8").replace("pub fn new(start: usize, end: usize) -> Match {", "pub fn new(start: usize, end: usize, strict: bool) -> Match {"));
  const hook = handleHook("post-edit", { cwd: root, tool_name: "Edit", tool_input: { file_path: lib } }, root);
  assert.match(hook.hookSpecificOutput.additionalContext, /- Match: changed: new; other blocks use it here: crates\/app\/src\/main\.rs:9, crates\/app\/src\/main\.rs:10, crates\/searcher\/src\/lib\.rs:17\s*$/m);
  const findings = findBreakingChanges(before, analyze(root, { skipGit: true }), "crates-matcher");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^Match changed from `pub struct Match \{[^`]*` to `pub struct Match \{[^`]*strict: bool/);
});

test("Rust: a briefing shows the declarations of the crates it uses", () => {
  const root = copyFixture("rust");
  const analysis = analyze(root, { skipGit: true });
  const prompt = renderContextPrompt(buildContextPack(analysis, "crates-searcher"), { root, inlineSources: false });
  assert.match(prompt, /`crates\/matcher\/src\/lib\.rs`\n```rust\n\/\/ A match: a range of bytes\.\npub struct Match \{/);
});
