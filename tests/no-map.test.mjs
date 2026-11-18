import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, check } from "../dist/index.js";
import { renderMsg } from "../dist/analysis/message.js";

function project() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-no-map-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"lib","type":"module"}\n');
  // A package and its own subfolder import each other: the root files are one block, the subfolder another.
  write("src/index.ts", 'import { leaf } from "./sub/leaf";\nexport function root(): string {\n  return leaf();\n}\nexport const shared = 1;\n');
  write("src/sub/leaf.ts", 'import { shared } from "../index";\nexport function leaf(): string {\n  return String(shared);\n}\n');
  return root;
}

test("a cycle between a folder and its own subfolder is explained when the blocks are inferred", () => {
  const analysis = analyze(project(), { skipGit: true });
  assert.equal(analysis.blocksInferred, true);
  const cycles = check(analysis).filter((finding) => finding.kind === "cycle");
  assert.equal(cycles.length, 1);
  assert.match(renderMsg(cycles[0].message), /A block and one of its own subfolders are in it/);
  assert.match(renderMsg(cycles[0].message), /^Dependency cycle: /);
});

test("with a saved map the same cycle is reported as it was", () => {
  const root = project();
  const model = {
    version: 1,
    name: "lib",
    blocks: [
      { id: "core", name: "Core", layer: "domain", include: ["src"] },
      { id: "leaf", name: "Leaf", layer: "domain", include: ["src/sub"] },
    ],
    dependencies: [],
  };
  const cycles = check(analyze(root, { model, skipGit: true }), model).filter((finding) => finding.kind === "cycle");
  assert.equal(cycles.length, 1);
  assert.doesNotMatch(renderMsg(cycles[0].message), /own subfolders/);
});
