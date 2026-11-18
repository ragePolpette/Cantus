import { launchTestBrowser } from "./helpers.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { analyze, buildViewData, renderViewHtml } from "../dist/index.js";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

function project(files) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-lanes-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const block = (id, name, include, layer = "unassigned") => ({ id, name, layer, include: [include] });
const model = (blocks) => ({ version: 1, name: "lanes", blocks, dependencies: [], rules: { allow: {} } });

test("without a saved map the blocks that have no layer sit in a lane per top-level folder, the users above the used", () => {
  const root = project({
    "src/core/db.ts": "export function connect() { return 1; }\n".repeat(1) + "// padding\n".repeat(40),
    "src/web/page.ts": 'import { connect } from "../core/db";\nexport const page = connect();\n',
    "examples/shop/app.ts": 'import { page } from "../../src/web/page";\nexport const app = page;\n',
    "examples/blog/app.ts": 'import { connect } from "../../src/core/db";\nexport const blog = connect();\n',
    "tools/one.ts": "export const one = 1;\n",
  });
  const blocks = [
    block("core", "Lib · Core", "src/core"),
    block("web", "Lib · Web", "src/web"),
    block("shop", "Lib · Examples · Shop", "examples/shop"),
    block("blog", "Lib · Examples · Blog", "examples/blog"),
    block("tools", "Tools", "tools"),
  ];
  const analysis = analyze(root, { model: model(blocks), skipGit: true });
  const view = buildViewData(analysis, undefined, []);
  assert.deepEqual(view.lanes, ["examples/", "web/", "core/", "tools/"], "users first, the lane nobody is linked to last");
  const byId = Object.fromEntries(view.blocks.map((entry) => [entry.id, entry]));
  assert.deepEqual([byId.shop.lane, byId.blog.lane, byId.web.lane, byId.core.lane, byId.tools.lane], ["examples/", "examples/", "web/", "core/", "tools/"]);
  assert.deepEqual([byId.shop.shortName, byId.blog.shortName, byId.core.shortName], ["Shop", "Blog", "Core"], "the part of the name the lane already says is dropped");
  assert.equal(byId.core.name, "Lib · Core", "the full name stays");
  assert.ok(byId.core.weight > byId.tools.weight && byId.core.weight <= 1, "weight follows the tokens");
  assert.equal(Math.max(...view.blocks.map((entry) => entry.weight)), 1);
});

test("with a saved map the lanes are its layers and nothing is regrouped", () => {
  const root = project({ "src/a/x.ts": "export const x = 1;\n", "src/b/y.ts": 'import { x } from "../a/x";\nexport const y = x;\n' });
  const saved = { ...model([block("a", "A", "src/a", "domain"), block("b", "B", "src/b", "ui")]), layers: ["ui", "domain"] };
  const view = buildViewData(analyze(root, { model: saved, skipGit: true }), saved, []);
  assert.deepEqual(view.lanes, ["ui", "domain"]);
  assert.deepEqual(view.blocks.map((entry) => `${entry.id}:${entry.lane}:${entry.shortName}`).sort(), ["a:domain:A", "b:ui:B"]);
});

test("without a saved map, blocks whose layer could be told keep it, and only the rest go by folder", () => {
  const root = project({ "src/api/a.ts": "export const a = 1;\n", "src/misc/m.ts": "export const m = 2;\n" });
  const blocks = [block("api", "Api", "src/api", "interface"), block("misc", "Misc", "src/misc")];
  const view = buildViewData(analyze(root, { model: model(blocks), skipGit: true }), undefined, []);
  assert.deepEqual(view.lanes.filter((lane) => lane !== "domain" && lane !== "application" && lane !== "infrastructure"), ["interface", "misc/"]);
});

test("the page: arrows are quiet until the block under the cursor lights its own; the lanes carry the folders; a bar shows the weight", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = project({
    "src/core/db.ts": "export function connect() { return 1; }\n" + "// padding\n".repeat(60),
    "src/web/page.ts": 'import { connect } from "../core/db";\nexport const page = connect();\n',
    "src/cli/run.ts": 'import { connect } from "../core/db";\nexport const run = connect();\n',
  });
  const blocks = [block("core", "Lib · Core", "src/core"), block("web", "Lib · Web", "src/web"), block("cli", "Lib · Cli", "src/cli")];
  const analysis = analyze(root, { model: model(blocks), skipGit: true });
  const file = path.join(root, "map.html");
  fs.writeFileSync(file, renderViewHtml(buildViewData(analysis, undefined, [])));
  const browser = await launchTestBrowser(chromium);
  t.after(() => browser.close());
  const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await p.goto("file://" + file);
  assert.deepEqual(await p.locator(".lane h2").allInnerTexts(), ["CLI/", "WEB/", "CORE/"].map((text) => text), "one lane per folder, the users above the used");
  assert.deepEqual(await p.locator(".card h3 span").allInnerTexts(), ["Cli", "Web", "Core"]);
  const opacities = () => p.locator("#edges > path").evaluateAll((paths) => paths.map((path) => path.getAttribute("opacity")));
  assert.deepEqual(await opacities(), ["0.4", "0.4"], "quiet by default");
  const widths = await p.locator(".card .weight i").evaluateAll((bars) => bars.map((bar) => parseFloat(bar.style.width)));
  assert.equal(Math.max(...widths), 100, "the largest block fills its bar");
  assert.ok(Math.min(...widths) < 100);
  await p.locator(".card", { hasText: "Web" }).hover();
  const lit = await p.locator("#edges > path").evaluateAll((paths) => paths.map((path) => path.getAttribute("opacity")).sort());
  assert.deepEqual(lit, ["0.15", "1"], "the arrow of the block under the cursor is lit, the other fades");
  await p.mouse.move(5, 5);
  assert.deepEqual(await opacities(), ["0.4", "0.4"], "and quiet again when the cursor leaves");
});
