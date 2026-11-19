// Run against a public repository with a known exported function and its callers.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [repo, apiFile, symbol] = process.argv.slice(2);
if (!repo || !apiFile || !symbol || !/^[A-Za-z_][\w]*$/.test(symbol)) {
  throw new Error("Usage: node benchmark/publication/smoke.mjs <checkout> <api-file> <function-name>");
}
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const sourceRepo = fs.realpathSync(repo);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRepo, encoding: "utf8" }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-public-smoke-"));
const gateArgs = ["diff", "HEAD", "--fail-on", "breaking"];
const runs = [];
const gate = {};

try {
  for (let trial = 1; trial <= 5; trial++) {
    const cwd = path.join(tmp, "trial-" + trial);
    execFileSync("git", ["clone", "--quiet", "--no-local", sourceRepo, cwd]);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(), revision);
    const modelPath = path.join(cwd, ".cantus", "model.json");
    const run = (...args) => {
      const start = performance.now();
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      return { ...result, ms: Math.round(performance.now() - start) };
    };
    const dry = run("init", "--no-serve", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(fs.existsSync(path.dirname(modelPath)), false, "dry run wrote .cantus");
    const first = run("init", "--no-serve");
    assert.equal(first.status, 0, first.stderr);
    const model = fs.readFileSync(modelPath, "utf8");
    const second = run("init", "--no-serve");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(modelPath, "utf8"), model, "re-running init changed the saved map");
    assert.equal(execFileSync("git", ["diff", "--name-only"], { cwd, encoding: "utf8" }), "");
    const view = run("view");
    assert.equal(view.status, 0, view.stderr);
    const htmlBytes = fs.statSync(path.join(cwd, ".cantus", "view.html")).size;
    const filesRead = Number(first.stdout.match(/(\d+) files read \(/)?.[1]);
    assert.ok(filesRead > 0);
    runs.push({ trial, filesRead, blocks: JSON.parse(model).blocks.length, dryRunMs: dry.ms, firstInitMs: first.ms,
      secondInitMs: second.ms, htmlRenderMs: view.ms, htmlBytes });

    if (trial !== 1) continue;
    const record = (phase, expected) => {
      const result = run(...gateArgs);
      gate[phase] = { exit: result.status, findings: result.stderr.trim().split("\n").filter(Boolean) };
      assert.equal(result.status, expected, result.stderr || result.stdout);
    };
    const defPath = path.resolve(cwd, apiFile);
    assert.ok(defPath.startsWith(cwd + path.sep), "function must be in the checkout");
    const source = fs.readFileSync(defPath, "utf8");
    const declaration = "export function " + symbol + "(";
    assert.equal(source.split(declaration).length, 2, "expected exactly one named declaration");
    const renamed = "cantusBenchmarkNewName";
    assert.ok(!source.includes(renamed));
    record("baseline", 0);
    // Rename the declaration and any same-file calls so the gate must find external consumers.
    const broken = source.replaceAll(new RegExp("\\b" + symbol + "\\b", "g"), renamed);
    fs.writeFileSync(defPath, broken);
    record("removedExport", 1);
    fs.writeFileSync(defPath, broken + "\nexport { " + renamed + " as " + symbol + " };\n");
    record("compatibilityAlias", 0);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify({
  revision,
  runtime: process.version,
  platform: process.platform + "-" + process.arch,
  cpu: os.cpus()[0]?.model,
  availableParallelism: os.availableParallelism(),
  apiFile, symbol, runs, gate,
}, null, 2));
