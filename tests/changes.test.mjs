import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { EditLedger, analyze, buildViewData, check } from "../dist/index.js";
import { fileDiff, gitSignature, readChanges } from "../dist/state/changes.js";
import { diffLines, splitLines } from "../dist/state/line-diff.js";
import { copyFixture, shopModel } from "./helpers.mjs";

function repo() {
  const root = copyFixture("shop");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/\nignored.ts\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return { root, run };
}

test("changes since the last commit: modified, staged, new, deleted and binary files; a commit resets them", () => {
  const { root, run } = repo();
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const vat = 0.22;\nexport const rounding = 2;\n");
  fs.writeFileSync(path.join(root, "src/orders/index.ts"), fs.readFileSync(path.join(root, "src/orders/index.ts"), "utf8").split("\n").slice(1).join("\n"));
  run("add", "src/orders/index.ts");
  const before = gitSignature(root);
  fs.writeFileSync(path.join(root, "src/web/new-page.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  fs.rmSync(path.join(root, "src/db/client.ts"));
  fs.writeFileSync(path.join(root, "src/web/logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  fs.writeFileSync(path.join(root, "ignored.ts"), "x\n");

  const changes = readChanges(root);
  assert.equal(changes.git, true);
  assert.deepEqual(changes.files, {
    "src/pricing/index.ts": { added: 3, removed: 0, status: "modified" },
    "src/orders/index.ts": { added: 0, removed: 1, status: "modified" },
    "src/web/new-page.ts": { added: 3, removed: 0, status: "added" },
    "src/db/client.ts": { added: 0, removed: 5, status: "deleted" },
    "src/web/logo.png": { added: 0, removed: 0, status: "added", binary: true },
  });
  assert.equal(gitSignature(root), before, "editing files moves neither HEAD nor the index");

  run("add", "-A");
  assert.notEqual(gitSignature(root), before, "staging moves the index: the live map refreshes");
  run("commit", "-q", "-m", "work");
  assert.deepEqual(readChanges(root).files, {}, "a commit resets the counts");
});

test("the map sums changes per block, deleted files included", () => {
  const { root } = repo();
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\n// one\n// two\n");
  fs.rmSync(path.join(root, "src/db/client.ts"));
  fs.writeFileSync(path.join(root, "src/pricing/rates.json"), "{\n  \"vat\": 0.22\n}\n");
  const model = shopModel();
  const analysis = analyze(root, { model, skipGit: true });
  const view = buildViewData(analysis, model, check(analysis, model), readChanges(root));
  const block = (id) => view.blocks.find((candidate) => candidate.id === id).changes;
  assert.deepEqual(block("src-pricing"), { added: 6, removed: 0, files: 2 }, "a non-source file under the block counts too");
  assert.deepEqual(block("src-db"), { added: 0, removed: 5, files: 1 });
  assert.deepEqual(block("src-web"), { added: 0, removed: 0, files: 0 });
  assert.equal(view.changes.git, true);
  assert.equal(view.changes.files["src/db/client.ts"].block, "src-db");
  assert.deepEqual([view.changes.added, view.changes.removed], [6, 5]);
});

test("changed files carry the agents the ledger knows wrote in them", () => {
  const { root } = repo();
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\n// by an agent\n");
  fs.rmSync(path.join(root, "src/db/client.ts"));
  const ledger = new EditLedger();
  const file = "src/pricing/index.ts";
  ledger.before("k", file, "x\n");
  ledger.after("k", file, "x\ny\n", "block-pricing");
  assert.deepEqual(ledger.agentsOf(file), ["block-pricing"]);
  assert.deepEqual(ledger.agentsOf("src/db/client.ts"), []);
  const model = shopModel();
  const analysis = analyze(root, { model, skipGit: true });
  const view = buildViewData(analysis, model, check(analysis, model), readChanges(root), (f) => ledger.agentsOf(f));
  assert.deepEqual(view.changes.files[file].agents, ["block-pricing"]);
  assert.equal("agents" in view.changes.files["src/db/client.ts"], false, "no agent known: no field");
});

test("a project outside git has no changes to show", () => {
  const root = copyFixture("shop");
  assert.deepEqual(readChanges(root), { git: false, files: {} });
  assert.equal(gitSignature(root), "");
  const analysis = analyze(root, { model: shopModel(), skipGit: true });
  assert.equal(buildViewData(analysis, shopModel(), []).changes.git, false);
});

test("line diff: the shortest edit script, with line numbers on both sides", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  assert.deepEqual(
    ops.map((op) => `${op.type === "same" ? " " : op.type === "add" ? "+" : "-"}${op.text}:${op.oldLine ?? ""}:${op.newLine ?? ""}`),
    [" a:1:1", "-b:2:", "+x::2", " c:3:3", " d:4:4", "+e::5"],
  );
  assert.deepEqual(splitLines("one\r\ntwo\n"), ["one", "two"]);
  assert.deepEqual(splitLines(""), []);
  // Random edits: the diff rebuilds both texts and is never longer than delete-all plus add-all.
  let seed = 7;
  const random = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: random(30) }, () => "abcde"[random(5)]);
    const b = Array.from({ length: random(30) }, () => "abcde"[random(5)]);
    const result = diffLines(a, b);
    assert.deepEqual(result.filter((op) => op.type !== "add").map((op) => op.text), a);
    assert.deepEqual(result.filter((op) => op.type !== "del").map((op) => op.text), b);
  }
});

test("a file against the last commit: modified, new, deleted, binary and unchanged", () => {
  const { root } = repo();
  const pricing = "src/pricing/index.ts";
  const original = fs.readFileSync(path.join(root, pricing), "utf8");
  fs.writeFileSync(path.join(root, pricing), original.replace(/\n/, "\n// note\n"));
  const modified = fileDiff(root, pricing);
  assert.equal(modified.status, "modified");
  assert.deepEqual(modified.ops.filter((op) => op.type !== "same").map((op) => [op.type, op.text, op.newLine]), [["add", "// note", 2]]);

  fs.writeFileSync(path.join(root, "src/web/new-page.ts"), "export const a = 1;\n");
  assert.deepEqual(fileDiff(root, "src/web/new-page.ts"), { path: "src/web/new-page.ts", status: "added", ops: [{ type: "add", text: "export const a = 1;", newLine: 1 }] });

  fs.rmSync(path.join(root, "src/db/client.ts"));
  const deleted = fileDiff(root, "src/db/client.ts");
  assert.equal(deleted.status, "deleted");
  assert.ok(deleted.ops.length > 0 && deleted.ops.every((op) => op.type === "del"));

  fs.writeFileSync(path.join(root, "src/web/logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  assert.deepEqual(fileDiff(root, "src/web/logo.png"), { path: "src/web/logo.png", status: "added", binary: true, ops: [] });

  const orders = fileDiff(root, "src/orders/index.ts");
  assert.equal(orders.status, "unchanged");
  assert.ok(orders.ops.every((op) => op.type === "same"));
});

test("changes are found when the project path is spelled differently from git's (symlink, junction, short name)", () => {
  const { root } = repo();
  const link = `${root}-link`;
  fs.symlinkSync(root, link, "junction");
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  fs.rmSync(path.join(root, "src/db/client.ts"));
  const changes = readChanges(link);
  assert.deepEqual(changes.files["src/pricing/index.ts"], { added: 2, removed: 0, status: "modified" });
  assert.equal(changes.files["src/db/client.ts"]?.status, "deleted");
});

test("with core.autocrlf, a file checked out with CRLF line endings is unchanged", () => {
  const { root, run } = repo();
  run("config", "core.autocrlf", "true");
  const file = "src/web/crlf.ts";
  fs.writeFileSync(path.join(root, file), "export const a = 1;\r\nexport const b = 2;\r\n");
  run("add", file);
  run("commit", "-q", "-m", "crlf");
  assert.equal(fileDiff(root, file).status, "unchanged");
  assert.equal(fileDiff(root, "src/orders/index.ts").status, "unchanged", "an LF file committed before autocrlf was set is unchanged too");
  fs.appendFileSync(path.join(root, file), "export const c = 3;\r\n");
  const modified = fileDiff(root, file);
  assert.equal(modified.status, "modified");
  assert.deepEqual(modified.ops.filter((op) => op.type !== "same").map((op) => op.type), ["add"]);
});

test("the commit position ignores Cantus's own files", async () => {
  const { gitPosition } = await import("../dist/state/changes.js");
  const { root } = repo();
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), "{}");
  assert.equal(gitPosition(root).uncommitted, 0);
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "// x\n");
  assert.equal(gitPosition(root).uncommitted, 1);
});
