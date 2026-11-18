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

/** The shop, in a repository whose main branch has its own name, with a second branch beside it. */
function shop(rules) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), ...(rules ? { agent: { worktree: rules } } : {}) }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n");
  git(root, "init", "-q", "-b", "master");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "branch", "release");
  return root;
}

const savedRules = (root) => JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8")).agent?.worktree;

async function call(server, method, body) {
  const res = await fetch(new URL("api/map/worktree-rules", server.url), {
    method,
    headers: { "x-cantus-token": server.token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

test("the worktree rules: read with the branches, the start point set once for the project, commands never from the page", async (t) => {
  const root = shop({ setup: ["npm ci"], copy: [".env"] });
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  t.after(() => server.close());

  const read = await call(server, "GET");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.branches.sort(), ["master", "release"]);
  assert.match(read.body.automatic, /^master \(/, "the main branch is found even when it is not called main");
  assert.match(read.body.resolved, /^master \(/);

  // A branch of the project's own: every new worktree starts from it.
  const saved = await call(server, "PUT", { base: "release", branch: "work/{slug}", copy: [".env", " .env.local "], link: [], setup: ["rm -rf /"], script: "evil.ps1" });
  assert.equal(saved.status, 200);
  assert.match(saved.body.resolved, /^release \(/);
  assert.deepEqual(savedRules(root), { setup: ["npm ci"], copy: [".env", ".env.local"], base: "release", branch: "work/{slug}" }, "commands stay as they were");

  // Empty means back to the default.
  await call(server, "PUT", { base: "", branch: "" });
  assert.equal(savedRules(root).base, undefined);
  assert.equal(savedRules(root).branch, undefined);

  // A start point that is not in the repository, or that looks like an option, is refused and nothing is written.
  for (const base of ["nonexistent", "--upload-pack=x"]) {
    const refused = await call(server, "PUT", { base });
    assert.equal(refused.status, 400, base);
    assert.equal(savedRules(root).base, undefined);
  }
});

test("the Sessions menu holds the rules: the start point is chosen from the branches and saved in the map", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");

  await openSessions(page);
  const menu = page.locator("#sessions");
  await menu.locator("#wt-rule-base").waitFor();
  assert.match(await menu.locator("#wt-rule-base option").first().innerText(), /master/);
  await menu.locator("#wt-rule-base").selectOption("release");
  await menu.locator("#wt-rule-branch").fill("work/{slug}");
  await menu.getByRole("button", { name: "Save the rules" }).click();
  await menu.getByText("Saved.").waitFor();
  assert.deepEqual(savedRules(root), { base: "release", branch: "work/{slug}" });

  // The menu stays where it was across a reload, and shows what was saved.
  await page.reload();
  await page.waitForSelector(".chip.live");
  await menu.locator("#wt-rule-base").waitFor();
  assert.equal(await menu.locator("#wt-rule-base").inputValue(), "release");
  await page.keyboard.press("Escape");
  assert.equal(await menu.isVisible(), false, "Esc closes it");
});

test("with a script in the map the menu shows it and leaves out copies and links, which a script does not use; without one it says where to set it", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop({ script: "tools/new-worktree.ps1", scriptArgs: ["-Branch", "{branch}"], copy: [".env"], link: ["packages"] });
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await openSessions(page);
  const menu = page.locator("#sessions");
  await menu.locator("#wt-rule-base").waitFor();
  assert.equal(await menu.locator("#wt-rule-copy").count(), 0);
  assert.equal(await menu.locator("#wt-rule-link").count(), 0);
  await menu.getByText("tools/new-worktree.ps1 -Branch {branch}").waitFor();
  await menu.getByText(/the script decides the folder/).waitFor();
  await menu.getByRole("button", { name: "Save the rules" }).click();
  await menu.getByText("Saved.").waitFor();
  assert.deepEqual(savedRules(root).link, ["packages"], "what the page does not show is kept as it was");

  const plain = shop();
  const other = await startMapServer(new ProjectState(plain), { port: 0, pollInterval: 100 });
  t.after(() => other.close());
  await page.goto(other.url);
  await page.waitForSelector(".chip.live");
  await openSessions(page);
  await menu.getByText(/set agent\.worktree\.script and scriptArgs in \.cantus\/model\.json/).waitFor();
  assert.equal(await menu.locator("#wt-rule-link").count(), 1);
});
