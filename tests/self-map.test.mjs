import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, check, loadModel } from "../dist/index.js";

const repository = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Cantus maps itself (.cantus/model.json). A file added outside every block, an import against the layer rules or one
// the map does not declare means the map no longer says what the code does.
test("the map of Cantus itself matches its code: no unassigned file, layer violation or dependency out of step", () => {
  const model = loadModel(repository);
  assert.ok(model, "the repository has a map");
  const findings = check(analyze(repository, { model }), model);
  const drift = findings.filter((finding) => ["unassigned-files", "layer-violation", "undeclared-dependency", "unused-dependency", "cycle"].includes(finding.kind));
  assert.deepEqual(drift.map((finding) => `${finding.kind}: ${finding.message}`), []);
});
