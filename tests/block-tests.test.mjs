import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, renderContextPrompt, testsByBlock } from "../dist/index.js";

function project(files, blocks) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-block-tests-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const model = { version: 1, name: "t", blocks: blocks.map(([id, include]) => ({ id, name: id, layer: "domain", include: [include] })), dependencies: [] };
  return { dir, model };
}

test("a block's tests: those in its folder, those importing its files, and none that only share a word", () => {
  const { dir, model } = project(
    {
      "package.json": '{"name":"t","type":"module"}',
      "src/billing/invoice.ts": "export function total(n: number) { return n; }\n",
      "src/billing/tax.ts": "export const rate = 0.2;\n",
      "src/billing/tax.test.ts": 'import { rate } from "./tax";\nconsole.log(rate);\n',
      "src/orders/order.ts": "export function place() { return 1; }\n",
      "tests/billing.test.ts": 'import { total } from "../src/billing/invoice";\nimport { place } from "../src/orders/order";\nconsole.log(total(1), place());\n',
      "tests/billing-notes.test.ts": 'console.log("invoice");\n',
    },
    [["billing", "src/billing"], ["orders", "src/orders"]],
  );
  const analysis = analyze(dir, { model, skipGit: true });
  const tests = testsByBlock(analysis);
  assert.deepEqual(
    tests.get("billing").map((entry) => [entry.file, entry.how, entry.covers]),
    [["src/billing/tax.test.ts", "inside", ["src/billing/tax.ts"]], ["tests/billing.test.ts", "imports", ["src/billing/invoice.ts"]]],
  );
  assert.deepEqual(tests.get("orders").map((entry) => [entry.file, entry.how]), [["tests/billing.test.ts", "imports"]]);

  const briefing = renderContextPrompt(buildContextPack(analysis, "billing", model), { root: dir, inlineSources: false });
  assert.match(briefing, /## Tests of this block/);
  assert.match(briefing, /`tests\/billing\.test\.ts` — covers `src\/billing\/invoice\.ts`/);
  assert.doesNotMatch(briefing, /billing-notes/);
});

test("Python tests are tied to a block by what they import, absolute or relative; an ambiguous name is not guessed", () => {
  const { dir, model } = project(
    {
      "pkg/__init__.py": "",
      "pkg/billing/__init__.py": "",
      "pkg/billing/invoice.py": "def total(n):\n    return n\n",
      "pkg/orders/__init__.py": "",
      "pkg/orders/order.py": "def place():\n    return 1\n",
      "tests/test_billing.py": "from pkg.billing.invoice import total\nfrom pkg.orders import order\n",
      "tests/test_relative.py": "from ..pkg.billing import invoice\n",
      "tests/test_nothing.py": "import os\nimport unittest\n",
    },
    [["billing", "pkg/billing"], ["orders", "pkg/orders"]],
  );
  const tests = testsByBlock(analyze(dir, { model, skipGit: true }));
  assert.deepEqual(tests.get("billing").map((entry) => entry.file), ["tests/test_billing.py", "tests/test_relative.py"]);
  assert.deepEqual(tests.get("orders").map((entry) => [entry.file, entry.covers]), [["tests/test_billing.py", ["pkg/orders/order.py"]]]);
});

test("Java tests are tied to the class they are named after, only when the name is unique", () => {
  const { dir, model } = project(
    {
      "src/main/java/app/billing/Invoice.java": "package app.billing;\npublic class Invoice { public int total() { return 1; } }\n",
      "src/main/java/app/orders/Order.java": "package app.orders;\npublic class Order { }\n",
      "src/main/java/app/orders/Util.java": "package app.orders;\npublic class Util { }\n",
      "src/main/java/app/billing/Util.java": "package app.billing;\npublic class Util { }\n",
      "src/test/java/app/InvoiceTest.java": "package app;\nclass InvoiceTest { }\n",
      "src/test/java/app/UtilTest.java": "package app;\nclass UtilTest { }\n",
    },
    [["billing", "src/main/java/app/billing"], ["orders", "src/main/java/app/orders"]],
  );
  const tests = testsByBlock(analyze(dir, { model, skipGit: true }));
  assert.deepEqual(tests.get("billing").map((entry) => [entry.file, entry.how, entry.covers]), [["src/test/java/app/InvoiceTest.java", "name", ["src/main/java/app/billing/Invoice.java"]]]);
  assert.equal(tests.get("orders"), undefined, "UtilTest could be either Util: not listed");
});

test("a project with no tests has no list, and the briefing has no section for it", () => {
  const { dir, model } = project({ "package.json": '{"name":"t"}', "src/a/a.ts": "export const a = 1;\n" }, [["a", "src/a"]]);
  const analysis = analyze(dir, { model, skipGit: true });
  assert.equal(testsByBlock(analysis).size, 0);
  assert.doesNotMatch(renderContextPrompt(buildContextPack(analysis, "a", model), { root: dir }), /## Tests/);
});

test("a block that is the whole project does not claim every test in the folder, only the ones that import its files", () => {
  const { dir, model } = project(
    {
      "package.json": '{"name":"t","type":"module"}',
      "src/index.ts": "export const x = 1;\n",
      "src/utils/u.ts": "export const u = 1;\n",
      "test/app.test.ts": 'import { x } from "../src/index";\nconsole.log(x);\n',
      "test/setup.ts": "export const setup = 1;\n",
    },
    [["root", "."], ["utils", "src/utils"]],
  );
  const tests = testsByBlock(analyze(dir, { model, skipGit: true }));
  assert.deepEqual(tests.get("root").map((entry) => [entry.file, entry.how]), [["test/app.test.ts", "imports"]]);
});
