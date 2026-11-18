import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareProject, deltaFailures, isEmptyDelta, renderDelta, untouchedCallers } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/** The shop with its map committed on main. */
function repo() {
  const root = copyFixture("shop");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/*.html\n");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  return { root, run, write, read };
}

/** A branch that renames an export other blocks call, and makes the domain reach for payments. */
function renameOrder({ write, read }, { updateCaller }) {
  write("src/orders/index.ts", read("src/orders/index.ts").replace("createOrder", "makeOrder"));
  if (updateCaller) write("src/checkout/index.ts", read("src/checkout/index.ts").replaceAll("createOrder", "makeOrder"));
  write("src/pricing/index.ts", `import { charge } from "../payments/stripe.js";\n${read("src/pricing/index.ts")}\nexport const pay = (total: number) => charge(total, "tok");\n`);
}

test("the working tree against main: a removed export still called, a new arrow, a new layer violation", () => {
  const project = repo();
  project.run("checkout", "-q", "-b", "feature");
  renameOrder(project, { updateCaller: false });

  const delta = compareProject(project.root, { base: "main" });
  assert.match(delta.base, /^main@[0-9a-f]{7}$/);
  assert.equal(delta.head, "working tree");
  assert.deepEqual(delta.dependencies.added.map((dep) => `${dep.from}>${dep.to}`), ["src-pricing>src-payments"]);
  assert.ok(delta.findings.added.some((finding) => finding.kind === "layer-violation" && finding.from === "src-pricing" && finding.to === "src-payments"));
  const renamed = delta.exports.changed.find((change) => change.name === "createOrder");
  assert.equal(renamed.kind, "removed");
  assert.deepEqual(renamed.callers.map((caller) => [caller.file, caller.block, caller.touched]), [["src/checkout/index.ts", "src-checkout", false]], "the caller was left as it was");
  assert.equal(untouchedCallers(delta), 1);
  assert.ok(delta.exports.added.some((entry) => entry.name === "makeOrder" && entry.block === "src-orders"));

  const text = renderDelta(delta);
  assert.match(text, /^# Map changes: main@[0-9a-f]{7} → working tree/);
  assert.match(text, /\*\*Look at first:\*\* 1 place\(s\) in other blocks still use an export/);
  assert.match(text, /- new `src-pricing` → `src-payments` \(charge\)/);
  assert.match(text, /- new \[warning\] Pricing \(domain\) depends on Payments/);
  assert.match(text, /- `createOrder` removed in `src\/orders\/index\.ts` \(`src-orders`\): 1 use\(s\) in other blocks, \*\*1 in files this change did not touch\*\*: `src\/checkout\/index\.ts:\d+`/);
});

test("a rename that updates its callers is not flagged, and a branch is read without being checked out", () => {
  const project = repo();
  project.run("checkout", "-q", "-b", "feature");
  renameOrder(project, { updateCaller: true });
  project.run("commit", "-q", "-am", "rename");
  project.run("checkout", "-q", "main");
  const headBefore = project.run("rev-parse", "HEAD");

  const delta = compareProject(project.root, { base: "main", head: "feature" });
  assert.match(delta.head, /^feature@[0-9a-f]{7}$/);
  const renamed = delta.exports.changed.find((change) => change.name === "createOrder");
  assert.deepEqual(renamed.callers.map((caller) => caller.touched), [true]);
  assert.equal(untouchedCallers(delta), 0);
  assert.match(renderDelta(delta), /1 use\(s\) in other blocks, all in files this change touched/);
  assert.doesNotMatch(renderDelta(delta), /Look at first/);

  assert.equal(project.run("rev-parse", "HEAD"), headBefore, "main stays checked out");
  assert.equal(project.run("status", "--porcelain").trim(), "", "nothing was written to the repository's working tree");
  assert.ok(!project.read("src/pricing/index.ts").includes("charge"), "the files on disk are main's");
});

test("an export moved to another file is a move, not a removal and a new export", () => {
  const project = repo();
  project.run("checkout", "-q", "-b", "feature");
  project.write("src/pricing/index.ts", project.read("src/pricing/index.ts").replace(/\nexport function discount[\s\S]*$/, "\n"));
  project.write("src/pricing/discount.ts", "export function discount(total: number) {\n  return total * 0.9;\n}\n");
  const delta = compareProject(project.root, { base: "main" });
  const moved = delta.exports.changed.find((change) => change.name === "discount");
  assert.equal(moved.kind, "moved");
  assert.equal(moved.movedTo, "src/pricing/discount.ts");
  assert.ok(!delta.exports.added.some((entry) => entry.name === "discount"));
  assert.match(renderDelta(delta), /`discount` moved from `src\/pricing\/index\.ts` to `src\/pricing\/discount\.ts`/);
});

test("compares from where the branch left main, not from main's tip", () => {
  const project = repo();
  project.run("checkout", "-q", "-b", "feature");
  project.write("src/web/extra.ts", "export const extra = 1;\n");
  project.run("add", "-A");
  project.run("commit", "-q", "-m", "feature work");
  project.run("checkout", "-q", "main");
  project.write("src/pricing/index.ts", `${project.read("src/pricing/index.ts")}\nexport const onlyOnMain = 1;\n`);
  project.run("commit", "-q", "-am", "main moves on");

  const delta = compareProject(project.root, { base: "main", head: "feature" });
  assert.ok(!delta.exports.added.some((entry) => entry.name === "onlyOnMain") && !delta.exports.changed.some((change) => change.name === "onlyOnMain"), "main's own work is not the branch's");
  assert.ok(delta.exports.added.some((entry) => entry.name === "extra"));
});

test("a project in a subfolder of the repository is compared by its own files", () => {
  const top = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-sub-"));
  const root = path.join(top, "app");
  fs.cpSync(copyFixture("shop"), root, { recursive: true });
  fs.rmSync(path.join(root, ".cantus"), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, ".cantus"));
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(top, "README.md"), "# not part of the project\n");
  const run = (...args) => execFileSync("git", args, { cwd: top, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(top, ".gitignore"), "cache/\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(root, "src/web/extra.ts"), "export const extra = 1;\n");
  const delta = compareProject(root, { base: "main" });
  assert.deepEqual(delta.exports.added.map((entry) => entry.file), ["src/web/extra.ts"]);
  assert.equal(delta.blocks.added.length + delta.blocks.removed.length, 0);
});

test("a map that exists only in the working tree is used for both sides", () => {
  const project = repo();
  project.run("rm", "-q", "--cached", ".cantus/model.json");
  project.run("commit", "-q", "-m", "stop tracking the map");
  const delta = compareProject(project.root, { base: "HEAD" });
  assert.equal(delta.inferred, false, "the base was read with the map the project has now");
  assert.equal(isEmptyDelta(delta), true);
  fs.rmSync(path.join(project.root, ".cantus/model.json"));
  assert.equal(compareProject(project.root, { base: "HEAD" }).inferred, true, "no map anywhere: blocks are inferred");
  const text = renderDelta(compareProject(project.root, { base: "HEAD" }));
  assert.match(text, /Neither `HEAD@\w+` nor `working tree` has a saved map/);
  assert.match(text, /Changed exports and their call sites, endpoints and calls are read from the files and are not affected/);
});

test("a comparison where one state has no saved map names it, and says what to trust", async () => {
  const { compareAnalyses } = await import("../dist/index.js");
  const { analyze } = await import("../dist/index.js");
  const project = repo();
  const read = (file) => fs.readFileSync(path.join(project.root, file), "utf8");
  const side = (label, model) => ({ label, analysis: analyze(project.root, { skipGit: true, ...(model ? { model } : {}) }), findings: [], read });
  const withMap = compareAnalyses(side("main", shopModel()), side("feature"));
  assert.deepEqual(withMap.inferredSides, ["head"]);
  assert.match(renderDelta(withMap), /`feature` has no saved map \(the other one does\)/);
  assert.match(renderDelta(withMap), /added or removed blocks and the arrows between blocks with care/);
});

test("no change is said plainly; an unknown branch is an error", () => {
  const project = repo();
  const delta = compareProject(project.root, { base: "main" });
  assert.equal(isEmptyDelta(delta), true);
  assert.match(renderDelta(delta), /No change to the blocks/);
  assert.throws(() => compareProject(project.root, { base: "nope" }), /"nope" is not a commit/);
});

test("`cantus diff` prints Markdown or JSON", () => {
  const project = repo();
  project.run("checkout", "-q", "-b", "feature");
  renameOrder(project, { updateCaller: false });
  const run = (...args) => spawnSync(process.execPath, [cli, "diff", ...args, "-C", project.root], { encoding: "utf8" });
  const markdown = run("main");
  assert.equal(markdown.status, 0);
  assert.match(markdown.stdout, /^# Map changes: main@/);
  const json = run("main", "--json");
  assert.equal(JSON.parse(json.stdout).dependencies.added[0].to, "src-payments");
  const bad = run("nope");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /"nope" is not a commit/);
});

test("an HTTP call whose action moved to another line is the same call, not one gone and one new", async () => {
  const { analyze } = await import("../dist/index.js");
  const { compareAnalyses } = await import("../dist/analysis/delta.js");
  const root = copyFixture("csharp");
  const side = (label) => ({ label, analysis: analyze(root, { skipGit: true }), findings: [], read: () => undefined });
  const base = side("base");
  const controller = path.join(root, "Controllers/OrdersController.cs");
  fs.writeFileSync(controller, `// a new comment\n// and another one\n${fs.readFileSync(controller, "utf8")}`);
  const moved = compareAnalyses(base, side("head"));
  assert.deepEqual(moved.endpoints.calls, { added: [], removed: [] }, "only the line of the handlers changed");

  // A call that really goes away is still reported, with the line it had.
  const page = path.join(root, "web/js", fs.readdirSync(path.join(root, "web/js"))[0]);
  fs.writeFileSync(page, fs.readFileSync(page, "utf8").split("\n").filter((line) => !line.includes("/api/legacy")).join("\n"));
  const gone = compareAnalyses(base, side("head")).endpoints.calls;
  assert.equal(gone.added.length, 0);
  assert.equal(gone.removed.length, 1);
  assert.match(gone.removed[0], /\/api\/legacy → LegacyController\.GetAll \(Controllers\/LegacyController\.cs:5\)/);
});

test("`cantus diff --fail-on` exits 1 when a removed export is still used or a new error appears, and says why", () => {
  const broken = repo();
  broken.run("checkout", "-q", "-b", "feature");
  renameOrder(broken, { updateCaller: false });
  const run = (project, ...args) => spawnSync(process.execPath, [cli, "diff", "main", ...args, "-C", project.root], { encoding: "utf8" });
  assert.equal(run(broken).status, 0, "without --fail-on it only reports");
  const failed = run(broken, "--fail-on", "breaking");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /1 place\(s\) still use an export that was removed/);
  assert.deepEqual(deltaFailures(compareProject(broken.root, { base: "main" }), "breaking").length, 1);

  // The caller is updated: nothing is broken. The new layer violation is only a warning, so "strict" is what stops it.
  const fixed = repo();
  fixed.run("checkout", "-q", "-b", "feature");
  renameOrder(fixed, { updateCaller: true });
  assert.equal(run(fixed, "--fail-on", "breaking").status, 0);
  const strict = run(fixed, "--fail-on", "strict");
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /new warning \[layer-violation\]/);

  const clean = repo();
  clean.run("checkout", "-q", "-b", "feature");
  assert.equal(run(clean, "--fail-on", "strict").status, 0, "no change passes");
  const bad = run(clean, "--fail-on", "nope");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /breaking" or "strict"/);
});

test("the breaking gate locates dangling local references and named re-exports in the new tree", () => {
  const project = repo();
  const file = "src/orders/query.ts";
  const barrel = "src/orders/public.ts";
  project.write(file, "export function getQuery() { return 42; }\nexport const validate = () => getQuery();\n");
  project.write(barrel, 'export { getQuery as query } from "./query.js";\n');
  project.run("add", "-A");
  project.run("commit", "-qm", "add query API");
  const gate = () => spawnSync(process.execPath, [cli, "diff", "HEAD", "--fail-on", "breaking"], { cwd: project.root, encoding: "utf8" });
  assert.equal(gate().status, 0);

  project.write(file, project.read(file).replace("function getQuery", "function readQuery"));
  project.write(barrel, "\n" + project.read(barrel));
  const broken = gate();
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /unresolved local reference .*src\/orders\/query.ts:2/);
  assert.match(broken.stderr, /unresolved re-export .*src\/orders\/public.ts:2/);

  project.write(file, project.read(file).replace("=> getQuery()", "=> readQuery()"));
  assert.doesNotMatch(gate().stderr, /unresolved local reference/);
  project.write(file, project.read(file) + "export { readQuery as getQuery };\n");
  const compatible = gate();
  assert.equal(compatible.status, 0, compatible.stderr);
  project.write(barrel, project.read(barrel).replace("getQuery as query", "readQuery as query"));
  project.write(file, project.read(file).replace("export { readQuery as getQuery };\n", ""));
  const fixed = gate();
  assert.equal(fixed.status, 0, fixed.stderr);
});
