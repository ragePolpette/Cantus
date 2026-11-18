import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const kit = path.join(root, "scripts", "prova-gate");
const cli = path.join(root, "dist", "cli.js");

// The scenarios of the gate, the retry, named checks, plans and the separate reviewer, with an agent that is a script:
// what they show is what Cantus does around the agent (the shell, the worktrees, the merge, the state files), on this
// machine. On Windows that is cmd.exe and its quoting, folders and paths of worktrees. A real agent is another matter
// (see scripts/prova-gate/LEGGIMI.md).
test("the gate, retry, named-check and plan scenarios pass with a scripted agent on this machine", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-prova-gate-test-"));
  const result = spawnSync(process.execPath, [path.join(kit, "prova-gate.mjs"), "--cli", cli, "--runner", path.join(kit, "runner-finto.mjs"), "--yes"], { cwd: out, encoding: "utf8", timeout: 20 * 60_000 });
  const reportFile = path.join(out, "prova-gate-report.json");
  assert.ok(fs.existsSync(reportFile), `no report written (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const bad = report.results.filter((entry) => entry.verdict !== "OK" && entry.verdict !== "INFO");
  assert.deepEqual(
    bad.map((entry) => `${entry.id}: ${entry.verdict}\n${(entry.checks ?? []).filter((check) => !check.pass).map((check) => `  - ${check.name} [${check.detail}]`).join("\n")}\n${entry.stderrTail ?? ""}`),
    [],
  );
  assert.deepEqual(
    report.results.map((entry) => entry.id).sort(),
    ["p1", "p2", "p3", "p4", "s1", "s2a", "s2b", "s3", "s4", "s5", "s6", "s7"],
  );
  assert.equal(result.status, 0);
});
