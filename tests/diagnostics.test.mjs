import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, buildViewData, check, writeAnalysisLog } from "../dist/index.js";
import { copyFixture, fixtures } from "./helpers.mjs";

const broken = path.join(fixtures, "broken");
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a broken project is analyzed fully and every problem is reported", () => {
  const analysis = analyze(broken, { skipGit: true });
  assert.deepEqual(analysis.blocks.map((info) => info.block.id), ["src-api", "src-core"]);
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to}`), ["src-api->src-core"]);

  const find = (stage, pattern) => analysis.diagnostics.filter((d) => d.stage === stage && pattern.test(`${d.file ?? ""} ${d.message}`));

  const syntax = find("parse", /src\/core\/rules\.ts Unexpected token/);
  assert.equal(syntax.length, 1, "syntax error reported once even though parse and contracts both see it");
  assert.equal(syntax[0].level, "error");
  assert.deepEqual([syntax[0].line, syntax[0].column], [5, 24]);
  assert.match(syntax[0].detail, /export const broken = \(;/);

  const unresolved = find("resolve", /cannot resolve "\.\.\/core\/does-not-exist\.js"/);
  assert.equal(unresolved[0].level, "warning");
  assert.match(analysis.unresolvedImports[0].reason, /Cannot find module/);

  assert.equal(find("packages", /packages\/bad\/package\.json invalid package\.json/)[0].level, "warning");
  assert.equal(find("packages", /has no name/).length, 0, "an invalid package.json is not also reported as nameless");
  assert.equal(find("resolve", /config\.json.*not an analyzed source file/)[0].level, "info");
  assert.equal(analysis.diagnostics[0].level, "error", "most severe first");
});

test("the view marks blocks with analysis problems", () => {
  const analysis = analyze(broken, { skipGit: true });
  const data = buildViewData(analysis, undefined, check(analysis));
  const block = (id) => data.blocks.find((candidate) => candidate.id === id);
  assert.equal(block("src-core").severity, "error");
  assert.equal(block("src-core").problems, 1, "the syntax error once: the fallback compiler's TS1109 at the same place is not counted again");
  assert.equal(block("src-api").severity, "warning");
  assert.ok(data.diagnostics.length >= 4);
});

test("the CLI writes the full log, prints errors, and check fails on analysis errors", () => {
  const root = copyFixture("broken");
  const result = runCli(["check", "-C", root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[error\] parse src\/core\/rules\.ts:5:24 — Unexpected token/);
  assert.doesNotMatch(result.stderr, /\[warning\]/, "warnings only with --verbose");
  assert.match(result.stderr, /full log in \.cantus\/analysis\.log/);

  const log = fs.readFileSync(path.join(root, ".cantus/analysis.log"), "utf8");
  assert.match(log, /Diagnostics: \d+ error\(s\), \d+ warning\(s\), \d+ info/);
  assert.match(log, /\[warning\] resolve src\/api\/server\.ts — cannot resolve/);
  assert.match(log, /\[warning\] packages packages\/bad\/package\.json — invalid package\.json/);

  const verbose = runCli(["analyze", "-C", root, "--verbose"]);
  assert.match(verbose.stderr, /\[warning\] resolve/);
  assert.match(verbose.stderr, /\[info\] resolve/);
});

test("a clean project gets an empty log and a passing check", () => {
  const root = copyFixture("mono");
  const result = runCli(["check", "-C", root]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /Analysis:/, "notes alone do not print a summary");
  assert.match(fs.readFileSync(path.join(root, ".cantus/analysis.log"), "utf8"), /No problems while reading the project\./);
});

test("unexpected failures are appended to the log with their stack", () => {
  const root = copyFixture("mono");
  fs.mkdirSync(path.join(root, ".cantus"));
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({
    version: 1,
    name: "x",
    blocks: [{ id: "a", name: "A", layer: "domain", include: ["packages"] }, { id: "a", name: "B", layer: "domain", include: ["src"] }],
    dependencies: [],
  }));
  const result = runCli(["check", "-C", root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate block id "a"/);
  const log = fs.readFileSync(path.join(root, ".cantus/analysis.log"), "utf8");
  assert.match(log, /\[crash\] .* cantus check -C /);
  assert.match(log, /at loadModel/);
});

test("the analysis log says where the time went", () => {
  const root = copyFixture("shop");
  const analysis = analyze(root, { skipGit: true });
  assert.ok(analysis.timings.total >= 0);
  assert.deepEqual(Object.keys(analysis.timings.stages), ["scan", "parse and imports", "other languages", "pages, globals and components", "C# backend", "links to pages", "contracts", "catalog", "git history"]);
  assert.equal(analysis.timings.slowestFiles.length, 5);
  writeAnalysisLog(root, analysis);
  const log = fs.readFileSync(path.join(root, ".cantus/analysis.log"), "utf8");
  assert.match(log, /^Time: \d+ ms — scan \d+, parse and imports \d+,/m);
  assert.match(log, /^Slowest files to read: src\/\S+ \d+ ms/m);
});

test("line and column of an offset: the same answers as counting newlines, for any offset and several sources in a row", async () => {
  const { lineColumn } = await import("../dist/analysis/diagnostics.js");
  const naive = (source, offset) => {
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < offset && index < source.length; index++) {
      if (source.charCodeAt(index) === 10) {
        line++;
        lineStart = index + 1;
      }
    }
    return { line, column: offset - lineStart + 1 };
  };
  const sources = ["", "\n", "a", "one\ntwo\r\nthree\n\n\nfour", "\n\nx\n", "no newline at all"];
  for (const source of [...sources, ...sources]) {
    for (let offset = -2; offset <= source.length + 3; offset++) {
      assert.deepEqual(lineColumn(source, offset), naive(source, offset), `${JSON.stringify(source)} at ${offset}`);
    }
  }
});
