import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { ProjectState, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel, launchTestBrowser } from "./helpers.mjs";

// A real browser is needed to see whether a form survives: the test is skipped where Playwright is not installed.
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the live map does not reload under a half-written form, and reloads once it is gone", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  // The browser leaves first: the server waits for its event stream to end.
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await page.evaluate(() => { window.__sameDocument = true; sessionStorage.setItem("cantus-edit", "1"); });
  await page.reload();
  await page.evaluate(() => { window.__sameDocument = true; });

  // Edit mode: open the "+ Block" form of a layer and type a name.
  await page.locator(".card.ghost").first().click();
  await page.locator("#canvas form input").first().fill("Half written");
  // The focus leaves the field (a click on the map, a key): only the form itself says it is half done.
  await page.evaluate(() => document.activeElement.blur());

  // The code changes: the page must stay, keep the text and say that it is stale.
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const touched = 1;\n");
  await page.waitForSelector("#stale-chip", { timeout: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(await page.evaluate(() => window.__sameDocument === true), true, "the page was not reloaded");
  assert.equal(await page.locator("#canvas form input").first().inputValue(), "Half written");

  // The form is cancelled (that reloads by itself); the pending change is shown on the fresh page.
  await page.locator("#canvas form button.secondary").first().click();
  await page.waitForSelector(".chip.live");
  assert.equal(await page.locator("#canvas form").count(), 0);
});

test("a change of the code reloads the page at once when nothing is half done", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  // The browser leaves first: the server waits for its event stream to end.
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await page.evaluate(() => { window.__sameDocument = true; });
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const touched = 2;\n");
  await until(async () => (await page.evaluate(() => window.__sameDocument === true).catch(() => false)) === false, "the page to reload");
});

test("while a specialist works the page still follows the code, at most every ten seconds", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  const token = await page.evaluate(() => JSON.parse(document.getElementById("live").textContent).token);
  await fetch(new URL("api/agents", server.url), { method: "POST", headers: { "x-cantus-token": token, "content-type": "application/json" }, body: JSON.stringify({ phase: "start", id: "a1", type: "block-src-pricing" }) });
  await page.evaluate(() => { window.__sameDocument = true; });
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const touched = 5;\n");
  await page.waitForSelector("#stale-chip", { timeout: 8000 });
  await until(async () => (await page.evaluate(() => window.__sameDocument === true).catch(() => false)) === false, "the page to reload although a specialist is working");
});

async function livePage(t, viewport) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await page.evaluate(() => { window.__sameDocument = true; });
  return { root, page, same: () => page.evaluate(() => window.__sameDocument === true).catch(() => false) };
}

test("a panel being read is not reloaded under the person; closing it goes back to the map, which then reloads", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const { root, page, same } = await livePage(t);
  await page.evaluate(() => { location.hash = "problems"; });
  await page.waitForSelector("#panel h1");
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const touched = 3;\n");
  await page.waitForSelector("#stale-chip", { timeout: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(await same(), true, "the page was not reloaded while the panel was open");
  assert.equal(await page.evaluate(() => location.hash), "#problems", "the panel has an address of its own");
  await page.locator("#panel-close").click();
  assert.equal(await page.evaluate(() => location.hash), "", "closing it goes back to the map");
  await until(async () => (await same()) === false, "the page to reload");
});

test("the page does not reload while the person moves the mouse or holds a button, and keeps where they were", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const { root, page, same } = await livePage(t, { width: 1200, height: 420 });
  const block = shopModel().blocks[0].id;
  await page.evaluate((id) => { location.hash = "block=" + id; }, block);
  await page.waitForSelector("#panel h1");
  await page.evaluate(() => { const p = document.getElementById("panel"); p.scrollTop = 120; });
  const scrolled = await page.evaluate(() => document.getElementById("panel").scrollTop);
  assert.ok(scrolled > 0, "the panel scrolls at this height");

  // Moving the mouse for longer than the quiet time: no reload under the pointer.
  await page.mouse.move(180, 200);
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const touched = 4;\n");
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(200 + (i % 2) * 40, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(await same(), true, "no reload while the mouse moves");
  await page.waitForSelector("#stale-chip");
  // A button held down: no reload either, however long.
  await page.mouse.down();
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(await same(), true, "no reload while a button is held");
  await page.mouse.up();
  await page.evaluate((id) => { if (location.hash !== "#block=" + id) location.hash = "block=" + id; document.getElementById("panel").scrollTop = 120; }, block);

  // Left alone, the page reloads and comes back to the same block, at the same height in the panel.
  await until(async () => (await same()) === false, "the page to reload");
  await page.waitForSelector("#panel h1");
  assert.equal(await page.evaluate(() => location.hash), "#block=" + block);
  await until(async () => (await page.evaluate(() => document.getElementById("panel").scrollTop)) === scrolled, "the panel to scroll back");
});
