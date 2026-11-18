import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { ProjectState, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel, openSessions, launchTestBrowser } from "./helpers.mjs";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function shopRepository() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/runs/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("the chip counts what waits for the person, and the column shows the worktree made for their session with the lines to open it", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shopRepository();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: never });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const p = await (await browser.newContext({ locale: "en-US" })).newPage();
  await p.goto(server.url);
  await p.waitForSelector(".chip.live");
  assert.equal(await p.locator("#needs-chip").count(), 0, "nothing waits: no badge on the Worktrees button");

  // A worktree made for the person's own session waits for the person to open it.
  const made = await fetch(new URL("api/worktrees", server.url), { method: "POST", headers: { "x-cantus-token": server.token, "content-type": "application/json" }, body: JSON.stringify({ block: "src-db", prompt: "Index the orders table", mode: "edit", isolation: "worktree" }) });
  assert.equal(made.status, 201);
  // The menu starts closed: the Worktrees button counts what waits and opens the column.
  await p.locator("#sessions-btn #needs-chip").waitFor();
  assert.equal(await p.locator("#needs-chip").textContent(), "1");
  assert.equal(await p.locator("#needs-chip").getAttribute("title"), "1 waiting for you");
  await openSessions(p, { details: false });
  const card = p.locator("#worktree-column .wtc", { hasText: "Index the orders table" });
  await card.waitFor();
  assert.equal(await card.locator(".wtc-state").innerText(), "off · ready", "nobody is there yet");

  // The card carries the lines to open it by hand, and opens the worktree's own panel.
  const lines = await card.locator("button", { hasText: "Copy for the terminal" }).getAttribute("title");
  assert.match(lines, /cd "[^"]+"\nclaude "Read \.cantus\/cache\/session-task\.md and do the task it describes\."/, "nobody opened it yet: the lines start the session on the task file, there is no conversation to continue");
  await card.locator("button", { hasText: "Open" }).click();
  await p.waitForFunction(() => location.hash.startsWith("#task="));
  assert.match(await p.locator("#panel").textContent(), /Index the orders table/);
});

