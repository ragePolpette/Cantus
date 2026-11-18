import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, buildViewData, check, renderPoster } from "../dist/index.js";
import { copyFixture, shopModel, launchTestBrowser } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

function shopView() {
  const model = shopModel();
  const analysis = analyze(copyFixture("shop"), { model, skipGit: true });
  return { analysis, view: buildViewData(analysis, model, check(analysis, model)) };
}

test("the poster is one SVG: a card per block in its lane, an arrow per dependency, the broken rule in orange", () => {
  const { analysis, view } = shopView();
  const svg = renderPoster(view);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1200 \d+"/);
  assert.match(svg, /<title id="t">shop: map of the code<\/title>/);
  assert.doesNotMatch(svg, /<script|<foreignObject|<image|@import|href=/, "nothing to load, nothing to run");
  for (const info of analysis.blocks) assert.ok(svg.includes(`<title>${info.block.name}`), `${info.block.name} has a card`);
  for (const layer of ["INTERFACE", "APPLICATION"]) assert.ok(svg.includes(`>${layer}</text>`), `the ${layer} lane is named`);
  const arrows = svg.match(/<path d="M[^"]+" fill="none"[^>]*marker-end="url\(#m-(?:ok|undeclared|violation|planned)\)"/g) ?? [];
  assert.equal(arrows.length, view.edges.length, "every arrow of the map is drawn once");
  const broken = view.edges.filter((edge) => edge.status === "violation").length;
  assert.ok(broken > 0, "the fixture has a layer rule broken");
  assert.equal((svg.match(/stroke="#d9701b" stroke-width="2\.40" opacity="0\.95"/g) ?? []).length, broken);
});

test("names are escaped, the width is the caller's, and a block the working tree touches gets an outline and its lines", () => {
  const { view } = shopView();
  const tricky = { ...view, blocks: view.blocks.map((block, index) => (index === 0 ? { ...block, shortName: 'Say "hi" <b> & co', name: 'Say "hi" <b> & co', changes: { added: 12, removed: 3, files: 2 } } : block)), changes: { ...view.changes, git: true } };
  const svg = renderPoster(tricky, { width: 900, subtitle: "branch feature/x" });
  assert.match(svg, /viewBox="0 0 900 /);
  assert.ok(svg.includes("Say &quot;hi&quot; &lt;b&gt; &amp; co"));
  assert.doesNotMatch(svg, /<b>/);
  assert.match(svg, /stroke="#0d6e92" stroke-width="2\.4"/, "outline of the touched block");
  assert.ok(svg.includes("+12 −3"));
  assert.ok(svg.includes("branch feature/x"));
  assert.ok(!renderPoster(view).includes("+12 −3"), "nothing marked touched when nothing changed");
});

test("`cantus view --svg` writes .cantus/map.svg, and --width is checked", () => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus", "model.json"), JSON.stringify(shopModel()));
  const run = (...args) => spawnSync(process.execPath, [cli, "view", ...args, "-C", root], { encoding: "utf8" });
  const made = run("--svg");
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /Wrote .*map\.svg\. It is a picture/);
  const svg = fs.readFileSync(path.join(root, ".cantus", "map.svg"), "utf8");
  assert.match(svg, /^<svg /);
  assert.ok(!fs.existsSync(path.join(root, ".cantus", "view.html")), "the page is not written when the picture is asked for");
  assert.equal(run("--svg", "--width", "800", "--out", "wide.svg").status, 0);
  assert.match(fs.readFileSync(path.join(root, "wide.svg"), "utf8"), /viewBox="0 0 800 /);
  assert.notEqual(run("--svg", "--width", "100").status, 0);
  const alone = run("--width", "800");
  assert.notEqual(alone.status, 0);
  assert.match(alone.stderr, /goes with --svg/);
});

test("a browser reads it as an image with no parse error", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const { view } = shopView();
  const browser = await launchTestBrowser(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage();
  const svg = renderPoster(view);
  const result = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    return { error: doc.querySelector("parsererror")?.textContent ?? null, cards: doc.querySelectorAll("g > title").length };
  }, svg);
  assert.equal(result.error, null);
  assert.equal(result.cards, view.blocks.length);
});

test("`cantus view --svg --base main` marks what the branch changed since it left main, committed work included", () => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus", "model.json"), JSON.stringify(shopModel()));
  const git = (...args) => { const done = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }); assert.equal(done.status, 0, done.stderr); };
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  const target = path.join(root, "src/pricing/index.ts");
  fs.appendFileSync(target, "\nexport const added = 1;\n");
  git("commit", "-q", "-am", "work");
  const run = (...args) => spawnSync(process.execPath, [cli, "view", "--svg", ...args, "-C", root], { encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(root, ".cantus", "map.svg"), "utf8"), /stroke="#0d6e92" stroke-width="2\.4"/, "committed: nothing left in the working tree");
  const based = run("--base", "main");
  assert.equal(based.status, 0, based.stderr);
  const svg = fs.readFileSync(path.join(root, ".cantus", "map.svg"), "utf8");
  assert.match(svg, /stroke="#0d6e92" stroke-width="2\.4"/);
  assert.match(svg, /\+2 −0/);
});
