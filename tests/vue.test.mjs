import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, handleHook, renderContextPrompt, writeProjectIndex } from "../dist/index.js";
import { kebabCase, sfcParts } from "../dist/analysis/vue.js";
import { copyFixture, fixtures } from "./helpers.mjs";

const vue = path.join(fixtures, "vue");

test("single-file components: the script is read in place, the template apart", () => {
  const source = fs.readFileSync(path.join(vue, "src/components/OrderList.vue"), "utf8");
  const parts = sfcParts(source);
  assert.equal(parts.lang, "ts");
  assert.equal(parts.script.length, source.length, "offsets are kept");
  assert.equal(parts.script.split("\n").length, source.split("\n").length, "lines are kept");
  assert.match(parts.script.split("\n")[10], /^import \{ formatTotal \} from "\.\.\/app\/format";/);
  assert.doesNotMatch(parts.script, /price-tag|scoped|color: red/);
  assert.match(parts.template.text, /<price-tag v-for/);
  assert.equal(kebabCase("OrderList"), "order-list");
  assert.equal(kebabCase("HTMLViewer"), "html-viewer");
});

test("Vue: imports from .vue files, global and file components, tags in templates, strings and pages", () => {
  const analysis = analyze(vue, { skipGit: true });
  assert.deepEqual(analysis.callSites.map((site) => `${site.file}:${site.line} ${site.symbol} -> ${site.targetFile}`), [
    "src/app/main.js:5 default -> src/components/OrderList.vue",
    "src/components/OrderList.vue:15 formatTotal -> src/app/format.ts",
    "legacy/dashboard.js:5 <price-tag> -> legacy/price-tag.js",
    "src/app/main.js:4 <order-list> -> src/components/OrderList.vue",
    "src/components/OrderList.vue:3 <price-tag> -> legacy/price-tag.js",
    "src/components/OrderList.vue:4 <modal> -> src/components/Modal.vue",
    "pages/dashboard.html:3 <price-tag> -> legacy/price-tag.js",
  ], "<table> is not Table.vue: one-word components count only in PascalCase");
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to} [${dep.symbols.join(",")}]`), [
    "src-app->src-components [<order-list>,default]",
    "src-components->src-app [formatTotal]",
    "src-components->vue-fixture [<price-tag>]",
  ]);
  assert.ok(!analysis.diagnostics.some((diagnostic) => diagnostic.level === "error"), "no .vue file is reported as unreadable");
  const prompt = renderContextPrompt(buildContextPack(analysis, "vue-fixture"), { root: vue, inlineSources: false });
  assert.match(prompt, /`<price-tag>` — 1 call site\(s\), all likely\n- `src\/components\/OrderList\.vue:3` \(src-components\)/, "callers from outside the block only");
});

test("the post-edit hook reads .vue files through their script", () => {
  const root = copyFixture("vue");
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  const file = path.join(root, "src/components/Modal.vue");
  fs.appendFileSync(file, "\n<style>.modal { color: blue; }</style>\n");
  assert.equal(handleHook("post-edit", { cwd: root, tool_name: "Edit", tool_input: { file_path: file } }, root), undefined);
  assert.ok(!fs.existsSync(path.join(root, ".cantus/hooks.log")));
});
