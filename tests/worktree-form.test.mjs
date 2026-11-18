import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { ProjectState, startMapServer } from "../dist/index.js";
import { registerWorktree } from "../dist/run/worktree-registry.js";
import { copyFixture, shopModel, openSessions, launchTestBrowser } from "./helpers.mjs";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function shop(rules) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), agent: { worktree: rules } }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

const idleRunner = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { yield { type: "result", ok: true, text: "done" }; })() });

test("the task form shows the worktree the rules give, and asks to agree to the setup commands every time", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop({ branch: "agent/{slug}", copy: [".env"], link: ["packages"], setup: ["echo prepare"] });
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await page.locator(".card", { hasText: "Pricing" }).first().click();
  const form = page.locator("#panel").filter({ has: page.locator("textarea") });
  await form.locator("textarea").fill("Add VAT to prices");
  const preview = page.locator("#panel .empty", { hasText: "Branch agent/add-vat-to-prices" });
  assert.equal(await form.locator("select").first().inputValue(), "new");
  await preview.waitFor();
  const text = await preview.innerText();
  assert.match(text, /Branch agent\/add-vat-to-prices · from main \([0-9a-f]{7}\)/);
  assert.match(text, /Copied in: \.env/);
  assert.match(text, /Linked to yours: packages/);
  assert.match(text, /echo prepare/);

  await form.locator("button", { hasText: "Prepare the worktree" }).click();
  await page.locator("#panel .finding.warning", { hasText: "Agree to run the commands above" }).waitFor();
  assert.deepEqual(await (await fetch(new URL("api/tasks", server.url), { headers: { "x-cantus-token": server.token } })).json(), [], "nothing started");

  await form.locator("input[type=checkbox]").check();
  await form.locator("button", { hasText: "Prepare the worktree" }).click();
  const listTasks = async () => (await fetch(new URL("api/tasks", server.url), { headers: { "x-cantus-token": server.token } })).json();
  let tasks = [];
  for (let i = 0; i < 100 && !tasks.length; i++) {
    tasks = await listTasks();
    if (!tasks.length) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(tasks.length, 1, await page.locator("#panel").innerText());
  assert.equal(tasks[0].worktree.branch, "agent/add-vat-to-prices");
});

test("the task form warns about another checkout changing the same blocks", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop({});
  const other = `${root}-other`;
  git(root, "worktree", "add", "-q", "-b", "feature/other", other);
  fs.appendFileSync(path.join(other, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  const byHand = `${root}-byhand`;
  git(root, "worktree", "add", "-q", "-b", "feature/byhand", byHand);
  fs.appendFileSync(path.join(byHand, "src/pricing/index.ts"), "\nexport const tax = 1;\n");
  registerWorktree(root, { path: other, branch: "feature/other", base: git(root, "rev-parse", "main"), task: "t1", session: false, prompt: "A task", createdAt: new Date().toISOString() });
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await page.locator(".card", { hasText: "Pricing" }).first().click();
  const warning = page.locator("#panel .finding.warning", { hasText: "The worktree feature/other changes 1 block of this one" });
  await warning.waitFor();
  assert.match(await warning.innerText(), /a worktree keeps their changes apart until you merge/);
  const names = warning.locator("details.collision .empty", { hasText: "src-pricing" });
  assert.equal(await names.isVisible(), false, "the block names are folded: one line each, not a wall of text");
  await warning.locator("summary").click();
  assert.equal(await names.isVisible(), true);
  assert.equal(await page.locator("#panel .finding.warning", { hasText: "feature/byhand" }).count(), 0, "a worktree made by hand is not reported, only those Cantus made");
  await page.locator(".card", { hasText: "Web" }).first().click();
  await page.locator("#panel textarea").waitFor();
  assert.equal(await page.locator("#panel .finding.warning", { hasText: "feature/other" }).count(), 0, "not on a block nobody else touches");
});

test("the task form can prepare a worktree for my own session: the panel gives the lines, then merge", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop({ branch: "agent/{slug}" });
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await page.locator(".card", { hasText: "Pricing" }).first().click();
  const form = page.locator("#panel").filter({ has: page.locator("textarea") });
  await form.locator("textarea").fill("Add VAT to prices");
  assert.equal(await form.locator("select").first().inputValue(), "new", "with no session open, a new worktree is the first answer");
  await page.locator("#panel .empty", { hasText: "Branch agent/add-vat-to-prices" }).waitFor();
  await form.locator("button", { hasText: "Prepare the worktree" }).click();
  const lines = page.locator("#panel pre.plan", { hasText: "claude" });
  await lines.waitFor();
  assert.match(await lines.innerText(), /^cd ".*"\nclaude "Read \.cantus\/cache\/session-task\.md and do the task it describes\."$/);
  assert.match(await page.locator("#panel .kicker").innerText(), /ready for your session/i);
  assert.equal(await page.locator("#panel button", { hasText: "Merge into your branch" }).count(), 1);
});

test("the map lists the worktrees Cantus made, badges the blocks they touch, and cleans up the merged ones", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop({});
  const base = git(root, "rev-parse", "main");
  const entry = (folder, branch, prompt) => registerWorktree(root, { path: folder, branch, base, task: `t-${branch}`, session: false, prompt, createdAt: new Date().toISOString() });
  const open = `${root}-open`;
  git(root, "worktree", "add", "-q", "-b", "feature/open", open);
  fs.appendFileSync(path.join(open, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  entry(open, "feature/open", "Add VAT to prices");
  const done = `${root}-done`;
  git(root, "worktree", "add", "-q", "-b", "feature/done", done);
  fs.appendFileSync(path.join(done, "src/orders/index.ts"), "\nexport const note = 1;\n");
  git(done, "commit", "-qam", "note");
  git(root, "merge", "-q", "--no-ff", "--no-edit", "feature/done");
  entry(done, "feature/done", "Note on orders");
  const byHand = `${root}-hand`;
  git(root, "worktree", "add", "-q", "-b", "feature/hand", byHand);
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForSelector(".chip.live");
  await openSessions(page, { details: false });
  const column = page.locator("#worktree-column");
  const card = (branch) => column.locator(`.wtc[data-branch="${branch}"]`);
  await card("feature/open").waitFor();
  assert.match(await card("feature/open").innerText(), /Add VAT to prices[^]*1 file not committed[^]*Blocks: Pricing/);
  assert.match(await card("feature/done").locator(".wtc-state").innerText(), /merged/);
  assert.equal(await card("feature/hand").count(), 1, "a worktree made by hand is a card too");
  assert.equal(await card("feature/hand").locator(".wtc-line", { hasText: "«" }).count(), 0, "with nothing of Cantus's task in it");
  assert.equal(await page.locator(".card", { hasText: "Pricing" }).first().locator(".badge.wt").innerText(), "1 worktree");
  assert.equal(await page.locator(".card", { hasText: "Web" }).first().locator(".badge.wt").count(), 0);

  await column.locator("button", { hasText: "Clean up 1 merged or gone" }).click();
  await column.locator(".empty", { hasText: "Removed: feature/done" }).waitFor();
  assert.equal(fs.existsSync(done), false);
  assert.equal(fs.existsSync(open), true, "the one with work in it stays");
  assert.equal(git(root, "branch", "--list", "feature/done"), "");
});

test("the task form asks one question, where the work goes; with a session open here the first answer is the lead of this worktree", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop({});
  const lead = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await lead.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(lead.url);
  await page.waitForSelector(".chip.live");
  await page.locator(".card", { hasText: "Pricing" }).first().click();
  const form = page.locator("#panel").filter({ has: page.locator("textarea") });
  const where = form.locator("select").first();
  assert.deepEqual(await where.locator("option").evaluateAll((options) => options.map((option) => option.value)), ["here", "new"], "no session run by the map, no plan or edit mode, no terminal to launch");
  assert.equal(await where.inputValue(), "here");
  const visible = async () => form.locator("select").evaluateAll((selects) => selects.map((select) => select.style.display !== "none"));
  assert.deepEqual((await visible()).slice(0, 2), [true, false], "only the question while the work goes to the lead (the model is for a new worktree's session)");
  assert.equal(await form.locator("button", { hasText: "Start task" }).count(), 0);

  await form.locator("textarea").fill("Add VAT to prices");
  await form.locator("button", { hasText: "Send to the lead" }).click();
  await page.locator("#panel .req-line", { hasText: "In queue" }).waitFor();

  await where.selectOption("new");
  assert.equal(await form.locator("button", { hasText: "Prepare the worktree" }).count(), 1);
  assert.deepEqual((await visible()).slice(0, 2), [true, true]);
});

test("the task form can send the work to the lead of another worktree that has a session open", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop({});
  const iva = `${root}-iva`;
  const quiet = `${root}-quiet`;
  git(root, "worktree", "add", "-q", "-b", "feature/iva", iva);
  git(root, "worktree", "add", "-q", "-b", "feature/quiet", quiet);
  const here = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner, session: true });
  const otherState = new ProjectState(iva);
  const other = await startMapServer(otherState, { port: 0, pollInterval: 100, runner: idleRunner, session: true });
  // A map from `cantus serve` has no session: not a place to send work to.
  const serveOnly = await startMapServer(new ProjectState(quiet), { port: 0, pollInterval: 100, runner: idleRunner });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await here.close(); await other.close(); await serveOnly.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(here.url);
  await page.waitForSelector(".chip.live");
  await page.waitForTimeout(600);
  await page.locator(".card", { hasText: "Pricing" }).first().click();
  const form = page.locator("#panel").filter({ has: page.locator("textarea") });
  const where = form.locator("select").first();
  assert.deepEqual(await where.locator("option").evaluateAll((options) => options.map((option) => option.value)), ["here", `peer:${other.url}`, "new"]);
  assert.match(await where.locator("option").nth(1).innerText(), /feature\/iva/);
  await where.selectOption(`peer:${other.url}`);
  await form.locator("textarea").fill("Add VAT to prices");
  await form.locator("button", { hasText: "Send to the lead" }).click();
  await page.locator("#panel a", { hasText: "Follow it on that worktree's map" }).waitFor();
  const queued = otherState.requests.list();
  assert.equal(queued.length, 1, "the request is in the queue of the other worktree's session");
  assert.equal(queued[0].prompt, "Add VAT to prices");
  assert.equal(queued[0].scope.block, "src-pricing");
  assert.equal(here.url === other.url, false);

  // Only a session's map from the registry: not an address the page makes up, and not this map itself.
  const post = (map) => fetch(new URL("api/peer-requests", here.url), { method: "POST", headers: { "x-cantus-token": here.token, "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", block: "src-pricing", map }) });
  assert.equal((await post("http://127.0.0.1:9/")).status, 409);
  assert.equal((await post(here.url)).status, 409);
  assert.equal((await post(serveOnly.url)).status, 409);
  assert.equal((await fetch(new URL("api/peer-requests", here.url), { method: "POST", body: "{}" })).status, 403, "needs the token");
});
