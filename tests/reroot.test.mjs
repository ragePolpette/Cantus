import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rerootModel } from "../dist/index.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const run = (root, ...args) => spawnSync(process.execPath, [cli, ...args, "-C", root], { encoding: "utf8" });

const oldModel = () => ({
  version: 1,
  name: "inner",
  layers: ["ui", "core"],
  blocks: [
    { id: "web", name: "Web", layer: "ui", include: ["web"], notes: [{ text: "Keep it small", files: ["web/index.js"] }] },
    { id: "app", name: "App", layer: "core", include: ["."] },
  ],
  dependencies: [{ from: "web", to: "app" }],
  docs: [{ path: "docs/blocks/web.md", blocks: ["web"] }],
  rules: { allow: { ui: ["core"] } },
  analysis: { exclude: ["vendor", "*.min.js", "assets/**"], externalRoots: { "../lib/Lib": "allow", "libs/Core": "deny" } },
});

test("reroot puts the folder in front of every path and keeps ids, arrows and the rest", () => {
  const { model, warnings } = rerootModel(oldModel(), "webroot");
  assert.deepEqual(model.blocks.map((block) => [block.id, block.include]), [["web", ["webroot/web"]], ["app", ["webroot"]]]);
  assert.deepEqual(model.blocks[0].notes[0].files, ["webroot/web/index.js"]);
  assert.equal(model.docs[0].path, "webroot/docs/blocks/web.md");
  assert.deepEqual(model.dependencies, [{ from: "web", to: "app" }]);
  assert.deepEqual(model.layers, ["ui", "core"]);
  assert.deepEqual(model.analysis.include, ["webroot"], "the new map reads the folder the old one read, not the whole root");
  assert.deepEqual(model.analysis.exclude, ["webroot/vendor", "*.min.js", "webroot/assets/**"]);
  assert.deepEqual(model.analysis.externalRoots, { "lib/Lib": "allow", "webroot/libs/Core": "deny" });
  assert.ok(warnings.some((warning) => /document/.test(warning)));
  assert.throws(() => rerootModel(oldModel(), "../x"), /not a folder inside/);
});

test("cantus reroot shows by default, writes with --write, and never over an existing map", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-reroot-"));
  fs.mkdirSync(path.join(root, "webroot/.cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, "webroot/.cantus/model.json"), JSON.stringify(oldModel()));
  const shown = run(root, "reroot", "--from", "webroot");
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Nothing written/);
  assert.ok(!fs.existsSync(path.join(root, ".cantus/model.json")));
  const written = run(root, "reroot", "--from", "webroot", "--write");
  assert.equal(written.status, 0, written.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8")).blocks[0].include[0], "webroot/web");
  assert.ok(fs.existsSync(path.join(root, "webroot/.cantus/model.json")), "the old map stays");
  const again = run(root, "reroot", "--from", "webroot", "--write");
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);
});
