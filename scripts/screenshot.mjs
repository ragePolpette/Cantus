#!/usr/bin/env node
// Regenerates docs/view.png: the live map of the demo fixture, with the Orders block selected.
// Needs Playwright with a Chromium build. When it is installed globally, point to it:
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node scripts/screenshot.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectState, startMapServer } from "../dist/index.js";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(repo, "docs", "view.png"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright").catch(() => {
  console.error("Playwright is not installed: npm install --no-save playwright, or set PLAYWRIGHT_MODULE.");
  process.exit(1);
});

// A copy, so the analysis caches never land in the repository.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-demo-"));
fs.cpSync(path.join(repo, "tests", "fixtures", "demo"), root, { recursive: true });
// A repository with one uncommitted change, so the map shows what changed since the last commit.
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n");
git("init", "-q", "-b", "main");
git("-c", "user.email=demo@example.com", "-c", "user.name=Demo", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start");
git("add", "-A");
git("-c", "user.email=demo@example.com", "-c", "user.name=Demo", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "demo shop");
fs.appendFileSync(path.join(root, "src", "orders", "index.ts"), "\n/** Cancels an order that has not shipped yet. */\nexport async function cancelOrder(id: number): Promise<void> {\n  await fetch(`/api/orders/${id}`, { method: \"DELETE\" });\n}\n");

const server = await startMapServer(new ProjectState(root), { port: 0 });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
  await page.goto(server.url);
  await page.click(".card:has-text('Orders')");
  await page.waitForSelector("h4:has-text('Callers')");
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
