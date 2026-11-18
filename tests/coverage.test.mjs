import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, check } from "../dist/index.js";

function repo() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-coverage-"));
  const write = (file, text = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"coverage"}');
  write("src/app.js", "export const app = 1;\n");
  write("src/view.html", "<html><body>plain</body></html>\n");
  write("scripts/deploy.ps1");
  write("scripts/build.sh");
  write("scripts/old/clean.ps1");
  write("index.html", "<html><body>no script</body></html>\n");
  write("web.config", "<configuration/>\n");
  write("logo.png");
  write("README.md");
  write("api/Api.csproj", "<Project/>\n");
  write("node_modules/dep/index.js");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A", "-f");
  run("commit", "-q", "-m", "init");
  return root;
}

const model = { version: 1, name: "coverage", blocks: [{ id: "src", name: "Src", layer: "interface", include: ["src"] }], dependencies: [], rules: { allow: {} } };

test("tracked files in no block and not read are counted, grouped by folder; assets, documents and manifests are not", () => {
  const analysis = analyze(repo(), { model, cache: false });
  assert.equal(analysis.uncovered.tracked, 12);
  assert.equal(analysis.uncovered.total, 5);
  assert.deepEqual(analysis.uncovered.folders, [
    { folder: "scripts", files: 3, extensions: [".ps1", ".sh"] },
    { folder: ".", files: 2, extensions: [".config", ".html"] },
  ], "src/view.html lies in a block's folder; node_modules, the picture, the README, package.json and the project file are not the map's business");
});

test("check and the map say it; analysis.exclude silences a folder", () => {
  const root = repo();
  const analysis = analyze(root, { model, cache: false });
  const finding = check(analysis, model).find((f) => f.kind === "uncovered-files");
  assert.equal(finding.severity, "info");
  assert.match(finding.message, /^5 of 12 tracked file\(s\) are in no block and are not read by Cantus: 3 in `scripts\/` \(\.ps1, \.sh\), 2 in the root \(\.config, \.html\)/);
  const quiet = analyze(root, { model: { ...model, analysis: { exclude: ["scripts"] } }, cache: false });
  assert.equal(quiet.uncovered.total, 2);
});

test("outside git there is nothing to count", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-nogit-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 1;\n");
  assert.equal(analyze(root, { cache: false }).uncovered, undefined);
});

test("a block of files git does not track is marked untracked, and said apart; a project that tracks nothing yet is not", () => {
  const root = repo();
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.writeFileSync(path.join(root, "tools/local.js"), "export const local = 1;\n");
  fs.writeFileSync(path.join(root, "tools/other.js"), "export const other = 1;\n");
  const two = { ...model, blocks: [...model.blocks, { id: "tools", name: "Tools", layer: "interface", include: ["tools"] }] };
  const analysis = analyze(root, { model: two, cache: false });
  assert.deepEqual(analysis.untrackedBlocks, ["tools"]);
  const finding = check(analysis, two).find((entry) => entry.kind === "untracked-block");
  assert.equal(finding.severity, "info");
  assert.match(finding.message, /Block `tools` holds only files git does not track/);

  // Committed, it is a block like any other.
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "tools"], { cwd: root });
  assert.equal(analyze(root, { model: two, cache: false }).untrackedBlocks, undefined);

  // A repository with nothing tracked yet has nothing to compare with.
  const fresh = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-fresh-"));
  fs.mkdirSync(path.join(fresh, "src"));
  fs.writeFileSync(path.join(fresh, "src/a.js"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fresh });
  assert.equal(analyze(fresh, { cache: false }).untrackedBlocks, undefined);
});
