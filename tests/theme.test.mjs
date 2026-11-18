import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { analyze, buildViewData, renderViewHtml } from "../dist/index.js";
import { fixtures, shopModel, launchTestBrowser } from "./helpers.mjs";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

function page() {
  const analysis = analyze(path.join(fixtures, "shop"), { model: shopModel(), skipGit: true });
  return renderViewHtml(buildViewData(analysis, shopModel(), []));
}

function cssAndScript(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  return { style, script };
}

test("the page defines a dark and a light palette and follows the system", () => {
  const { style } = cssAndScript(page());
  assert.match(style, /:root \{ color-scheme: dark;/);
  assert.match(style, /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\) \{ color-scheme: light;/);
  assert.match(style, /:root\[data-theme="light"\] \{ color-scheme: light;/);
});

test("every color is a variable: no hex literal outside the palette blocks", () => {
  const { style, script } = cssAndScript(page());
  const outside = style.replace(/(:root[^{]*\{[^}]*\})/g, "").replace(/@font-face[^}]*\}/g, "");
  assert.deepEqual(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
  assert.deepEqual(script.match(/#[0-9a-fA-F]{6}\b/g) ?? [], [], "the script draws with variables, not literal colors");
});

test("each palette gives the same set of variables, and every var() used is defined", () => {
  const { style } = cssAndScript(page());
  const blocks = [...style.matchAll(/:root[^{]*\{([^}]*)\}/g)].map((m) => m[1]).filter((b) => b.includes("color-scheme"));
  assert.equal(blocks.length, 3);
  const names = blocks.map((b) => [...b.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).sort());
  assert.deepEqual(names[1], names[0]);
  assert.deepEqual(names[2], names[0]);
  const used = new Set([...style.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
  const fonts = ["sans", "mono"].filter((f) => style.includes(`--${f}:`));
  for (const name of used) assert.ok(names[0].includes(name) || fonts.includes(name), `--${name} is used but not defined`);
});

test("the side panel starts closed, opens on a pick and has a close control", () => {
  const html = page();
  const { script, style } = cssAndScript(html);
  assert.match(style, /body\.panel-closed #panel, body\.panel-closed #panel-close \{ display:none; \}/);
  assert.match(script, /var panelOpen = false;/);
  assert.match(script, /panelClose\.addEventListener\("click", closePanel\)/);
  assert.match(script, /event\.key === "Escape" && panelOpen/);
  assert.match(script, /classList\.toggle\("review", !!\(fileViewOpen && fromChanges\)\)/, "toggle needs a real boolean: undefined flips the class");
  for (const view of ["block", "selection", "group", "zoom", "api", "changes", "file", "doc", "task"]) {
    assert.match(script, new RegExp(`view = "${view}";[^\\n]*openPanel\\(\\);`), `${view} opens the panel`);
  }
});

test("the header has a theme selector (system, light, dark) and the choice is applied before the first paint", () => {
  const html = page();
  const { script } = cssAndScript(html);
  assert.match(script, /themeSelect\.id = "theme"/);
  assert.match(script, /\[\["system", tr\("System"\)\], \["light", tr\("Light"\)\], \["dark", tr\("Dark"\)\]\]/);
  const boot = html.match(/<script id="theme-boot">([\s\S]*?)<\/script>/)[1];
  assert.ok(html.indexOf('id="theme-boot"') < html.indexOf("<style>"), "the theme is set before the styles are painted");
  assert.match(boot, /localStorage\.getItem\("cantus-theme"\)/);
});

test("the theme selector forces light or dark, follows the system, and is remembered", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page()); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await new Promise((resolve) => server.close(resolve)); } });
  browser = await launchTestBrowser(chromium);
  const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);

  const context = await browser.newContext({ colorScheme: "dark" });
  const p = await context.newPage();
  await p.goto(url);
  assert.equal(await p.locator("#theme").inputValue(), "system");
  assert.equal(await p.locator("html").getAttribute("data-theme"), null);
  const dark = await bg(p);

  await p.locator("#settings-btn").click();
  await p.selectOption("#theme", "light");
  assert.equal(await p.locator("html").getAttribute("data-theme"), "light");
  const light = await bg(p);
  assert.notEqual(light, dark, "light on a dark system changes the colors");

  await p.reload();
  assert.equal(await p.locator("#theme").inputValue(), "light", "the choice is kept");
  assert.equal(await bg(p), light);

  await p.locator("#settings-btn").click();
  await p.selectOption("#theme", "system");
  assert.equal(await p.locator("html").getAttribute("data-theme"), null);
  assert.equal(await bg(p), dark, "back to following the system");
  await p.reload();
  assert.equal(await p.locator("#theme").inputValue(), "system");

  // Dark forced on a light system.
  const lightSystem = await browser.newContext({ colorScheme: "light", locale: "it-IT" });
  const q = await lightSystem.newPage();
  await q.goto(url);
  const systemLight = await bg(q);
  assert.equal(systemLight, light);
  assert.deepEqual(await q.locator("#theme option").allInnerTexts(), ["Sistema", "Chiaro", "Scuro"]);
  await q.locator("#settings-btn").click();
  await q.selectOption("#theme", "dark");
  assert.equal(await bg(q), dark);
});
