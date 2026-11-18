import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, selectTests } from "../dist/index.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/**
 * A small TypeScript project: `price` is used by `cart`, `cart` by `checkout`; `slug` by nothing but its test.
 * `smoke.test.ts` runs the program and imports nothing of the project.
 */
function project() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-test-impact-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"shop","type":"module"}\n');
  write("src/price.ts", "export function price(n: number): number {\n  return n * 2;\n}\n");
  write("src/cart.ts", 'import { price } from "./price";\nexport function total(items: number[]): number {\n  return items.map(price).reduce((a, b) => a + b, 0);\n}\n');
  write("src/checkout.ts", 'import { total } from "./cart";\nexport function pay(items: number[]): string {\n  return String(total(items));\n}\n');
  write("src/slug.ts", "export function slug(text: string): string {\n  return text.trim();\n}\n");
  write("tests/cart.test.ts", 'import { total } from "../src/cart";\ntotal([1]);\n');
  write("tests/checkout.test.ts", 'import { pay } from "../src/checkout";\npay([1]);\n');
  write("tests/slug.test.ts", 'import { slug } from "../src/slug";\nslug("a");\n');
  write("tests/smoke.test.ts", 'import { spawnSync } from "node:child_process";\nspawnSync("node", ["bin.js"]);\n');
  write("README.md", "# shop\n");
  return root;
}

const change = (status = "modified") => ({ added: 1, removed: 0, status });
const pick = (root, changes) => selectTests(analyze(root, { skipGit: true }), changes);

test("a change reaches the tests of the files that use it, directly and through others", () => {
  const selection = pick(project(), { "src/price.ts": change() });
  assert.equal(selection.mode, "selected");
  assert.deepEqual(selection.tests, ["tests/cart.test.ts", "tests/checkout.test.ts", "tests/smoke.test.ts"]);
  assert.equal(selection.total, 4);
  assert.equal(selection.unlinked, 1);
  assert.match(selection.reasons.join("\n"), /tests\/smoke\.test\.ts/);
});

test("a change in a leaf reaches only its own test, and a test that imports nothing always runs", () => {
  const selection = pick(project(), { "src/slug.ts": change() });
  assert.deepEqual(selection.tests, ["tests/slug.test.ts", "tests/smoke.test.ts"]);
});

test("a changed test runs, and a document changes nothing", () => {
  const selection = pick(project(), { "tests/slug.test.ts": change(), "README.md": change() });
  assert.deepEqual(selection.tests, ["tests/slug.test.ts", "tests/smoke.test.ts"]);
  assert.match(selection.reasons.join("\n"), /1 changed file\(s\) cannot change a test/);
});

test("when Cantus cannot follow the change it says so and runs every test", () => {
  const root = project();
  const all = ["tests/cart.test.ts", "tests/checkout.test.ts", "tests/slug.test.ts", "tests/smoke.test.ts"];
  for (const [changes, why] of [
    [{ "src/price.ts": change("deleted") }, /was deleted/],
    [{ "package.json": change() }, /not code whose tests Cantus can follow/],
    [{ "src/Orders.java": change() }, /not code whose tests Cantus can follow/],
    [{ "scripts/build.ts": change() }, /is in no block|in no block/],
    [{ "tests/helpers/fixture.ts": change() }, /not a test/],
  ]) {
    const selection = pick(root, changes);
    assert.equal(selection.mode, "all", JSON.stringify(changes));
    assert.deepEqual(selection.tests, all);
    assert.match(selection.reasons[0], why);
  }
  assert.equal(selectTests(analyze(root, { skipGit: true }), undefined).mode, "all", "outside git nothing is known");
});

test("Python: a test is tied to the module it imports, and conftest.py is shared by the tests", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-test-impact-py-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("app/__init__.py", "");
  write("app/rates.py", "def rate():\n    return 2\n");
  write("app/money.py", "from app.rates import rate\n\ndef convert(x):\n    return x * rate()\n");
  write("app/names.py", "def name():\n    return 'a'\n");
  write("tests/test_money.py", "from app.money import convert\n\ndef test_it():\n    assert convert(1) == 2\n");
  write("tests/test_names.py", "from app.names import name\n\ndef test_it():\n    assert name() == 'a'\n");
  write("tests/conftest.py", "");
  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(selectTests(analysis, { "app/rates.py": change() }).tests, ["tests/test_money.py"]);
  assert.deepEqual(selectTests(analysis, { "app/names.py": change() }).tests, ["tests/test_names.py"]);
  const shared = selectTests(analysis, { "tests/conftest.py": change() });
  assert.equal(shared.mode, "all");
  assert.deepEqual(shared.tests.sort(), ["tests/conftest.py", "tests/test_money.py", "tests/test_names.py"]);
});

test("cantus tests prints one test per line and explains itself on stderr", () => {
  const root = project();
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/*.html\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  const tests = (...args) => spawnSync(process.execPath, [cli, "tests", ...args, "-C", root], { encoding: "utf8" });

  const none = tests();
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "tests/smoke.test.ts\n", "nothing changed: only the test that is tied to nothing");
  fs.appendFileSync(path.join(root, "src/slug.ts"), "// edit\n");
  const one = tests();
  assert.equal(one.stdout, "tests/slug.test.ts\ntests/smoke.test.ts\n");
  assert.match(one.stderr, /2 of 4 test file\(s\) can be affected/);

  run("checkout", "-q", "-b", "work");
  run("commit", "-q", "-am", "slug");
  fs.appendFileSync(path.join(root, "src/price.ts"), "// edit\n");
  const since = tests("main");
  assert.equal(since.stdout, "tests/cart.test.ts\ntests/checkout.test.ts\ntests/slug.test.ts\ntests/smoke.test.ts\n", "the branch's commit and the uncommitted edit both count");
  const json = JSON.parse(tests("--json").stdout);
  assert.equal(json.mode, "selected");
  assert.deepEqual(json.tests, ["tests/cart.test.ts", "tests/checkout.test.ts", "tests/smoke.test.ts"]);
  assert.equal(tests("nope").status, 1);
});
