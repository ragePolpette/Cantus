import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, check } from "../dist/index.js";

function project(files) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-oversized-"));
  for (const [file, lines] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), Array.from({ length: lines }, (_, i) => `export const v${i} = "${"x".repeat(60)}";`).join("\n") + "\n");
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}');
  return dir;
}

const model = (include, extra = {}) => ({ version: 1, name: "demo", blocks: [{ id: "all", name: "All", layer: "domain", include }], dependencies: [], rules: { allow: {} }, ...extra });

test("a block over the token limit is reported with where it splits", () => {
  const dir = project({ "src/orders/a.js": 120, "src/orders/b.js": 120, "src/billing/c.js": 120, "src/billing/d.js": 120, "src/util/e.js": 20 });
  const m = model(["src"], { analysis: { maxBlockTokens: 3000 } });
  const analysis = analyze(dir, { model: m, skipGit: true });
  const findings = check(analysis, m).filter((finding) => finding.kind === "oversized-block");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].blocks, ["all"]);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].message, /All \(all\) holds ~\d+k tokens in 5 file\(s\): too much for one agent to work on as a unit\. It splits along its subfolders: `(?:orders|billing)` \(2 file\(s\)[^)]*\), `(?:orders|billing)` \(2 file\(s\)[^)]*\), `util` \(1 file\(s\)/);
  assert.match(findings[0].message, /raise `analysis\.maxBlockTokens`/);
});

test("the limit is 40k by default, and 0 turns the finding off", () => {
  const dir = project({ "src/a.js": 20 });
  const small = model(["src"]);
  assert.deepEqual(check(analyze(dir, { model: small, skipGit: true }), small).filter((finding) => finding.kind === "oversized-block"), []);

  const big = project({ "src/a.js": 1300, "src/b.js": 1300 });
  const bigModel = model(["src"]);
  const analysis = analyze(big, { model: bigModel, skipGit: true });
  assert.ok(analysis.blocks[0].tokens > 40_000);
  const flat = check(analysis, bigModel).find((finding) => finding.kind === "oversized-block");
  assert.ok(flat, "over 40k tokens");
  assert.doesNotMatch(flat.message, /splits along/, "two files, nothing to divide by");

  const off = model(["src"], { analysis: { maxBlockTokens: 0 } });
  assert.deepEqual(check(analyze(big, { model: off, skipGit: true }), off).filter((finding) => finding.kind === "oversized-block"), []);
});
