import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";

function repo() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-ignore-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const code = "export function save(order) {\n  return order;\n}\n";
  write("package.json", '{"name":"ignored"}');
  write(".gitignore", "wwwroot/\ngen/\n*.gen.js\n");
  write("src/app.js", code);
  write("src/forced.js", code);
  write("src/old.gen.js", code);
  write("wwwroot/app.js", code); // a generated copy of the sources
  write("gen/main.js", code);
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("add", "-f", "src/old.gen.js"); // tracked although it matches an ignore rule
  run("commit", "-q", "-m", "init");
  return root;
}

const files = (analysis) => analysis.blocks.flatMap((info) => info.files).sort();

test("what .gitignore ignores is not analyzed, unless it is tracked or a block names it", () => {
  const root = repo();
  const names = (analysis) => files(analysis).filter((file) => !file.endsWith("package.json"));
  assert.deepEqual(names(analyze(root, { cache: false })), ["src/app.js", "src/forced.js", "src/old.gen.js"], "wwwroot, gen/ left out; the tracked .gen.js stays");

  const all = analyze(root, { model: { version: 1, name: "ignored", blocks: [{ id: "all", name: "All", layer: "unassigned", include: ["."] }], dependencies: [], rules: { allow: {} }, analysis: { respectGitignore: false } }, cache: false });
  assert.ok(files(all).includes("wwwroot/app.js") && files(all).includes("gen/main.js"), "respectGitignore: false reads everything");

  const named = { version: 1, name: "ignored", blocks: [{ id: "src", name: "Src", layer: "unassigned", include: ["src"] }, { id: "www", name: "Www", layer: "unassigned", include: ["wwwroot"] }], dependencies: [], rules: { allow: {} } };
  const withBlock = analyze(root, { model: named, cache: false });
  assert.ok(files(withBlock).includes("wwwroot/app.js"), "a block that includes the folder reads it");
  assert.ok(!files(withBlock).includes("gen/main.js"));
  assert.ok(withBlock.diagnostics.some((diagnostic) => /ignored by git left out of the analysis: .*gen\//.test(diagnostic.message)));
});

test("outside a git repository nothing is left out", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-nogit-"));
  fs.mkdirSync(path.join(root, "wwwroot"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "wwwroot/\n");
  fs.writeFileSync(path.join(root, "wwwroot/a.js"), "export const a = 1;\n");
  assert.ok(files(analyze(root, { cache: false })).includes("wwwroot/a.js"));
});
