import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("package validation rejects valid WebAssembly that is not a usable Tree-sitter grammar", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-invalid-package-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["scripts", "dist/analysis", "grammars", "licenses"]) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cantus-integrity-test", version: "0.0.0", type: "module", files: ["dist", "grammars", "licenses", "NOTICE"] }));
  for (const file of ["README.md", "LICENSE", "NOTICE", "licenses/IBM-Plex.LICENSE", "dist/cli.js", "dist/index.js", "dist/index.d.ts", "dist/main.js", "dist/analysis/language-worker.js", "dist/analysis/csharp-worker.js"]) fs.writeFileSync(path.join(dir, file), "fixture\n");
  const emptyWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  assert.equal(WebAssembly.validate(emptyWasm), true);
  for (const [grammar, license] of [["c_sharp", "c-sharp"], ["go", "go"], ["java", "java"], ["php", "php"], ["python", "python"], ["rust", "rust"]]) {
    fs.writeFileSync(path.join(dir, "grammars", `tree-sitter-${grammar}.wasm`), emptyWasm);
    fs.writeFileSync(path.join(dir, "grammars", `tree-sitter-${license}.LICENSE`), "fixture license\n");
  }
  fs.copyFileSync(path.join(root, "scripts/check-package.mjs"), path.join(dir, "scripts/check-package.mjs"));
  fs.copyFileSync(path.join(root, "scripts/npm-cli.mjs"), path.join(dir, "scripts/npm-cli.mjs"));
  fs.symlinkSync(fs.realpathSync(path.join(root, "node_modules")), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const run = spawnSync(process.execPath, [path.join(dir, "scripts/check-package.mjs")], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(run.error);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  for (const grammar of ["c_sharp", "go", "java", "php", "python", "rust"]) assert.ok(run.stderr.includes(`Cannot use grammars/tree-sitter-${grammar}.wasm:`), run.stderr);
  assert.doesNotMatch(run.stdout, /Validated \d+ required files/);
});
