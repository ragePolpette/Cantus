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

test("the panel of a block: who works there, what to look at, where to ask; the briefing is behind a fold that stays as it was left", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const iva = `${root}-iva`;
  git(root, "worktree", "add", "-q", "-b", "feature/iva", iva);
  fs.appendFileSync(path.join(iva, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  const state = new ProjectState(iva);
  const lead = await startMapServer(state, { port: 0, pollInterval: 100, session: true });
  state.requests.touch();
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await main.close(); await lead.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#worktree-column, #sessions-btn").first().waitFor({ state: "attached" });
  await page.locator(".card", { hasText: "Pricing" }).first().click();
  const panel = page.locator("#panel");
  await panel.locator("h1", { hasText: "Pricing" }).waitFor();
  // The worktree list arrives on its own: the section appears with it.
  await panel.locator(".section", { hasText: "Who works here" }).waitFor();
  const who = await panel.locator(".section", { hasText: "Who works here" }).innerText();
  assert.match(who, /working · feature\/iva/);

  // Order: who, what to look at, where to ask, then the closed briefing.
  const order = await panel.evaluate((node) => [...node.children].map((child) => (child.id === "briefing" ? "briefing" : child.querySelector?.("h4")?.textContent?.toLowerCase() ?? child.tagName.toLowerCase())).filter((name) => /who works here|findings|start a task|briefing/.test(name)));
  assert.deepEqual(order.map((name) => (name.startsWith("start a task") ? "form" : name.replace(/\d+$/, ""))), ["who works here", "findings", "form", "briefing"]);
  assert.equal(await page.locator("#briefing").evaluate((node) => node.open), false);
  assert.match(await page.locator("#briefing > summary").innerText(), /what the agent sees · briefing ~\d+ tokens/i);
  assert.equal(await page.locator("#briefing .section", { hasText: "Owned code" }).isVisible(), false, "closed: the code, contracts and callers are not on the page's first screen");

  // Open once: it stays open for the next block, and the owned code, neighbors and callers are inside it.
  await page.locator("#briefing > summary").click();
  assert.equal(await page.locator("#briefing .section", { hasText: "Owned code" }).isVisible(), true);
  assert.equal(await page.locator("#briefing .section", { hasText: "Callers · keep compatible" }).count(), 1);
  assert.equal(await page.locator("#briefing .section", { hasText: "Findings" }).count(), 0, "findings are not inside it");
  await page.locator(".card", { hasText: "Orders" }).first().click();
  await panel.locator("h1", { hasText: "Orders" }).waitFor();
  assert.equal(await page.locator("#briefing").evaluate((node) => node.open), true);
  assert.equal(await panel.locator(".section", { hasText: "Who works here" }).count(), 0, "nobody works on Orders");
});
