import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, inferBlocks } from "../dist/index.js";

function project(files) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-balance-"));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "export const x = 1;\n");
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}');
  return dir;
}

const sizes = (analysis) => Object.fromEntries(analysis.blocks.map((info) => [info.block.id, info.files.length]));

test("a directory holding most of the project is split along its subdirectories", () => {
  const files = [];
  for (const sub of ["query", "schema", "util", "dialects"]) for (let i = 0; i < 12; i++) files.push(`lib/${sub}/f${i}.js`);
  files.push("lib/index.js", "lib/helper.js");
  const dir = project(files);
  const blocks = sizes(analyze(dir, { skipGit: true }));
  assert.deepEqual(blocks, { lib: 2, "lib-dialects": 12, "lib-query": 12, "lib-schema": 12, "lib-util": 12 });
  const named = analyze(dir, { skipGit: true }).blocks.find((info) => info.block.id === "lib-query").block;
  assert.deepEqual(named.include, ["lib/query"]);
});

test("a split goes on until the pieces are small, and the parent disappears when it owns no file itself", () => {
  const files = [];
  for (const sub of ["a", "b"]) for (const leaf of ["x", "y", "z"]) for (let i = 0; i < 15; i++) files.push(`src/${sub}/${leaf}/f${i}.js`);
  const blocks = sizes(analyze(project(files), { skipGit: true }));
  assert.deepEqual(Object.keys(blocks).sort(), ["src-a-x", "src-a-y", "src-a-z", "src-b-x", "src-b-y", "src-b-z"]);
  assert.ok(Object.values(blocks).every((count) => count === 15));
});

test("many tiny sibling directories are merged into a few blocks; a few are left alone", () => {
  const tiny = Array.from({ length: 10 }, (_, i) => `src/m${String(i).padStart(2, "0")}/index.js`);
  const merged = analyze(project([...tiny, "src/big/a.js", "src/big/b.js", "src/big/c.js", "src/big/d.js", "src/big/e.js"]), { skipGit: true });
  const ids = merged.blocks.map((info) => info.block.id);
  assert.deepEqual(ids, ["src-big", "src-small"]);
  const small = merged.blocks.find((info) => info.block.id === "src-small");
  assert.equal(small.files.length, 10);
  assert.equal(small.block.include.length, 10);
  assert.match(small.block.name, /Small modules/);

  const few = analyze(project(tiny.slice(0, 5)), { skipGit: true });
  assert.equal(few.blocks.length, 5);
});

test("merged groups stay within a size cap", () => {
  const files = Array.from({ length: 20 }, (_, i) => `src/m${String(i).padStart(2, "0")}/a.js`);
  const analysis = analyze(project(files), { skipGit: true });
  const groups = analysis.blocks.filter((info) => info.block.id.startsWith("src-small"));
  assert.equal(groups.length, 2);
  assert.ok(groups.every((info) => info.files.length <= 12));
});

test("the proposal is deterministic and never leaves a file without a block", () => {
  const files = [];
  for (const sub of ["a", "b", "c"]) for (let i = 0; i < 20; i++) files.push(`lib/${sub}/f${i}.js`);
  const dir = project(files);
  const first = inferBlocks(dir, files);
  assert.deepEqual(first, inferBlocks(dir, files));
  const analysis = analyze(dir, { skipGit: true });
  assert.equal(analysis.blocks.reduce((sum, info) => sum + info.files.length, 0), 60);
});
