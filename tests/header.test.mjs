import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { ProjectState, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel, launchTestBrowser } from "./helpers.mjs";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function shop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("the header stays on one line at 1280 px with sessions waiting and signals on; the rest is behind Signals, the settings and the bottom bar", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  // Three worktrees waiting for the person's session, and an uncommitted change.
  for (const prompt of ["Index the orders table", "Add VAT", "Rename the cart"]) {
    const made = await fetch(new URL("api/worktrees", server.url), { method: "POST", headers: { "x-cantus-token": server.token, "content-type": "application/json" }, body: JSON.stringify({ block: "src-db", prompt, mode: "edit", isolation: "worktree" }) });
    assert.equal(made.status, 201);
  }
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const extra = 1;\n");

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn #needs-chip").waitFor();
  assert.equal(await page.locator("#needs-chip").textContent(), "3");
  const lines = await page.evaluate(() => {
    const header = document.querySelector("header").getBoundingClientRect();
    const items = [...document.querySelectorAll("header .brand, #tabs button, #chips > *, #settings-btn")].map((node) => node.getBoundingClientRect());
    return { height: header.height, tops: [...new Set(items.map((r) => Math.round(r.top + r.height / 2)))] };
  });
  assert.ok(lines.height <= 64, `one line: ${lines.height}px`);
  assert.ok(Math.max(...lines.tops) - Math.min(...lines.tops) <= 4, `all on the same line: ${lines.tops}`);

  // The counts are in the bottom bar, the legend behind its "?".
  assert.match(await page.locator("#facts").innerText(), /6 blocks[^]*dependencies[^]*live/);
  assert.equal(await page.locator("#legend").isVisible(), false);
  await page.locator("#legend-btn").click();
  assert.match(await page.locator("#legend").innerText(), /aligned with the model/);

  // Signals: the warnings with their blocks; a block opens from there.
  await page.locator("#signals-btn").click();
  assert.equal(await page.locator("#legend").isVisible(), false, "one small menu at a time");
  await page.waitForFunction(() => location.hash === "#signals");
  const warning = page.locator("#panel .signal.warning").first();
  await warning.locator("a.where").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#block="));

  // The settings hold the theme, the language and editing the map; Esc closes them.
  await page.locator("#settings-btn").click();
  assert.equal(await page.locator("#settings #theme").isVisible(), true);
  assert.equal(await page.locator("#settings #lang").isVisible(), true);
  assert.equal(await page.locator("#settings #edit-map").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#settings").isVisible(), false);
  // While editing, the header says so and turns it off.
  await page.locator("#settings-btn").click();
  await page.locator("#edit-map").click();
  await page.waitForSelector("#chips #edit-map.on");
  assert.equal(await page.locator("#chips #edit-map").innerText(), "Done editing");
});
