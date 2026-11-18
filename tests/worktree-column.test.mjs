import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { ProjectState, personalConfigPath, startMapServer } from "../dist/index.js";
import { registerWorktree } from "../dist/run/worktree-registry.js";
import { finishWorktree } from "../dist/run/worktree-report.js";
import { touchPeer } from "../dist/index.js";
import { copyFixture, shopModel, launchTestBrowser } from "./helpers.mjs";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

// Claude Code's store and the person's own settings are folders of this test, never the real ones.
const claudeHome = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-claude-"));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.env.XDG_CONFIG_HOME = path.join(claudeHome, "config");
process.env.APPDATA = path.join(claudeHome, "config");
/** A conversation Claude Code kept for a folder, as it names the folder that keeps it. */
function talkedIn(folder, id) {
  const dir = path.join(claudeHome, "projects", fs.realpathSync.native(folder).replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"type":"user"}\n');
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

const idleRunner = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { yield { type: "result", ok: true, text: "done" }; })() });
const api = (server, route, init = {}) => fetch(new URL(route, server.url), { ...init, headers: { "x-cantus-token": server.token, "content-type": "application/json", ...(init.headers ?? {}) } });

test("a lead that got in touch is working, one that did not is the person's turn; the other maps read it from the record of its server", async (t) => {
  const root = shop();
  const iva = `${root}-iva`;
  git(root, "worktree", "add", "-q", "-b", "feature/iva", iva);
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  const state = new ProjectState(iva);
  const lead = await startMapServer(state, { port: 0, pollInterval: 100, session: true });
  t.after(async () => { await lead.close(); await main.close(); });
  const find = async () => (await (await api(main, "api/worktrees")).json()).checkouts.find((checkout) => checkout.branch === "feature/iva");
  const before = await find();
  assert.equal(before.capo, true);
  assert.equal(before.capoSeenAt, undefined, "open, and nothing heard from it yet");
  state.requests.touch();
  const after = await find();
  assert.match(after.capoSeenAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(Date.now() - Date.parse(after.capoSeenAt) < 5000);
  assert.deepEqual(after.blocks, [], "the blocks it changes (none yet)");
  assert.equal(typeof after.behind, "number");
});

test("the column: a card per worktree, the one of this map first, each in its state with what to do next", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const base = git(root, "rev-parse", "main");
  const working = `${root}-working`;
  git(root, "worktree", "add", "-q", "-b", "feature/working", working);
  const review = `${root}-review`;
  git(root, "worktree", "add", "-q", "-b", "feature/review", review);
  fs.appendFileSync(path.join(review, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  git(review, "commit", "-qam", "vat");
  registerWorktree(root, { path: review, branch: "feature/review", base, task: "t-review", session: true, prompt: "Add VAT to prices", createdAt: new Date().toISOString() });
  const idle = `${root}-idle`;
  git(root, "worktree", "add", "-q", "-b", "feature/idle", idle);
  talkedIn(idle, "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab");
  const done = `${root}-done`;
  git(root, "worktree", "add", "-q", "-b", "feature/done", done);
  fs.appendFileSync(path.join(done, "src/orders/index.ts"), "\nexport const note = 1;\n");
  git(done, "commit", "-qam", "note");
  git(root, "merge", "-q", "--no-ff", "--no-edit", "feature/done");
  registerWorktree(root, { path: done, branch: "feature/done", base, task: "t-done", session: true, prompt: "Note on orders", createdAt: new Date().toISOString() });

  const mainState = new ProjectState(root);
  const main = await startMapServer(mainState, { port: 0, pollInterval: 100, runner: idleRunner, session: true });
  const workingState = new ProjectState(working);
  const lead = await startMapServer(workingState, { port: 0, pollInterval: 100, session: true });
  workingState.requests.touch();
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await lead.close(); await main.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");

  // One chip for all of it: no separate Requests chip.
  assert.equal(await page.locator("#sessions-btn").innerText().then((text) => text.split("\n")[0].trim()), "Worktrees");
  assert.equal(await page.locator("#requests-btn").count(), 0);
  await page.locator("#sessions-btn").click();
  const cards = page.locator("#worktree-column .wtc");
  await cards.nth(4).waitFor();
  assert.equal(await cards.count(), 5);
  assert.equal(await cards.first().locator(".wtc-name").innerText(), "main");
  assert.equal(await cards.first().locator(".tag").innerText(), "this map");
  const card = (branch) => page.locator(`#worktree-column .wtc[data-branch="${branch}"]`);

  // This map's lead was never heard from: just opened, and not the person's turn yet. The working one touched its map a moment ago.
  assert.equal(await cards.first().locator(".wtc-state").innerText(), "just opened");
  assert.equal(await card("feature/working").getAttribute("class").then((value) => value.includes("working")), true);
  assert.equal(await card("feature/working").locator(".wtc-state").innerText(), "working");
  assert.equal(await card("feature/working").locator("a.wtc-name").getAttribute("href"), lead.url, "its name opens its map");

  // No lead open and commits to look at: to review, with what it did and the lines that take it up in a terminal.
  const reviewCard = card("feature/review");
  assert.equal(await reviewCard.locator(".wtc-state").innerText(), "to review");
  const text = await reviewCard.innerText();
  assert.match(text, /Add VAT to prices/);
  assert.match(text, /1 commit/);
  assert.match(text, /lead off/);
  assert.match(text, /Blocks: Pricing/);
  const lines = await reviewCard.locator("button", { hasText: "Copy for the terminal" }).getAttribute("title");
  assert.equal(lines, `cd "${review}"\nclaude`, "nobody talked to Claude there: `--continue` would say \"No conversation found\"");
  assert.equal(await reviewCard.locator("button", { hasText: "Copy the verify command" }).getAttribute("title"), `cantus verify -C "${review}"`, "run in the worktree: there it knows the task and the lead's report");

  // Nothing to review and nobody there: off. Taken into the main line: merged, and Cantus can clear the ones it made.
  assert.equal(await card("feature/idle").locator(".wtc-state").innerText(), "off");
  assert.equal(await card("feature/idle").locator("button").count(), 1, "it can still be taken up from a terminal");
  assert.equal(await card("feature/idle").locator("button").getAttribute("title"), `cd "${idle}"\nclaude --resume 0b1c2d3e-aaaa-bbbb-cccc-1234567890ab`, "where Claude Code kept a conversation, that one is taken up");
  assert.equal(await card("feature/done").locator(".wtc-state").innerText(), "merged");
  assert.equal(await card("feature/done").locator("button").count(), 0, "nothing to take up in a merged one");

  // The cards are ordered: this map, then what waits for the person, what works, what to review, what is off, what is merged.
  const order = await cards.evaluateAll((nodes) => nodes.map((node) => node.dataset.branch));
  assert.deepEqual(order, ["main", "feature/working", "feature/review", "feature/idle", "feature/done"]);

  const clean = page.locator("#worktree-column button", { hasText: "Clean up 1 merged or gone" });
  await clean.click();
  await page.locator("#worktree-column .empty", { hasText: "Removed: feature/done" }).waitFor();
  assert.equal(fs.existsSync(done), false);
  assert.equal(fs.existsSync(review), true, "the one with work in it stays");
});

test("a request waits in the card of this map, and the lead's silence is said", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const state = new ProjectState(root);
  const main = await startMapServer(state, { port: 0, pollInterval: 100, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await main.close(); } });
  browser = await launchTestBrowser(chromium);
  const made = await api(main, "api/requests", { method: "POST", body: JSON.stringify({ prompt: "Rename quote to price", scope: { block: "src-pricing" } }) });
  assert.equal(made.status, 201);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn").click();
  const queue = page.locator("#worktree-column .wtc.here .wtc-queue");
  await queue.waitFor();
  assert.match(await queue.innerText(), /requests · 1[^]*Rename quote to price[^]*In queue/i);
  assert.match(await queue.innerText(), /not been heard from yet|last heard|session is active/);
  assert.equal(await page.locator("#worktree-column .wtc").count(), 1, "one worktree, one card, git or not");
});

test("a card with a map running is a link to it and takes the selection along; one with none is not a link", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const iva = `${root}-iva`;
  const idle = `${root}-idle`;
  git(root, "worktree", "add", "-q", "-b", "feature/iva", iva);
  git(root, "worktree", "add", "-q", "-b", "feature/idle", idle);
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  const side = await startMapServer(new ProjectState(iva), { port: 0, pollInterval: 100 });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await side.close(); await main.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn").click();
  const cards = page.locator("#worktree-column .wtc");
  await cards.nth(2).waitFor();
  assert.equal(await page.locator("#worktree-column a.wtc-name").count(), 1, "only a worktree with a map running is a link");
  assert.equal(await page.locator("#worktree-column a.wtc-name").getAttribute("href"), side.url);
  assert.equal(await page.locator('#worktree-column .wtc[data-branch="feature/idle"] strong.wtc-name').getAttribute("title"), "No map is open for this worktree");

  // The selection is the page's address: it goes along, and the other map shows its own column with itself first.
  await page.locator(".card", { hasText: "Pricing" }).first().click();
  await page.waitForFunction(() => location.hash.startsWith("#block="));
  const hash = await page.evaluate(() => location.hash);
  await Promise.all([page.waitForURL((url) => url.href === `${side.url}${hash}`), page.locator("#worktree-column a.wtc-name").click()]);
  await page.waitForSelector(".chip.live");
  assert.match(await page.title(), /feature\/iva/);
  await page.locator("#sessions-btn").click();
  assert.equal(await page.locator("#worktree-column .wtc.here .wtc-name").innerText(), "feature/iva");
  assert.equal(await page.locator("#worktree-column a.wtc-name", { hasText: "main" }).getAttribute("href"), main.url, "and the way back");
});

test("a worktree whose setup commands wait for the person's yes shows at the top of the column, and the link opens its panel", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const model = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...model, agent: { worktree: { setup: ["echo prepare"] } } }, null, 2));
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await main.close(); } });
  browser = await launchTestBrowser(chromium);
  const made = await api(main, "api/worktrees", { method: "POST", body: JSON.stringify({ block: "src-pricing", prompt: "Add VAT to prices", mode: "edit", isolation: "worktree", confirmOnMap: true }) });
  assert.equal(made.status, 201);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn").click();
  const asks = page.locator("#worktree-column .wtc-asks");
  await asks.waitFor();
  assert.match(await asks.innerText(), /Waiting for your approval · .*Add VAT to prices/);
  await asks.locator("a").click();
  await page.waitForFunction(() => location.hash.startsWith("#task="));
  assert.match(await page.locator("#panel").innerText(), /echo prepare/);
  // The task panel is for a prepared worktree: the one question it asks, and nothing to steer an agent with.
  await page.locator("#panel button", { hasText: "Allow" }).waitFor();
  const panel = await page.locator("#panel").innerText();
  for (const gone of ["Accept edits", "Send reply", "Delegations", "Activity", "Verification", "Always allow"]) assert.ok(!panel.includes(gone), gone);
  assert.equal(await page.locator("#panel button", { hasText: /^Stop$/ }).count(), 0);
});

test("a worktree prepared and not yet opened gives the lines that start its session on the task file, not `claude --continue`", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await main.close(); } });
  browser = await launchTestBrowser(chromium);
  const made = await (await api(main, "api/worktrees", { method: "POST", body: JSON.stringify({ block: "src-pricing", prompt: "Add VAT to prices", mode: "edit", isolation: "worktree" }) })).json();
  for (let i = 0; i < 200; i++) {
    if ((await (await api(main, `api/tasks/${made.id}`)).json()).status === "prepared") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn").click();
  const copy = page.locator('#worktree-column .wtc:not(.here) button', { hasText: "Copy for the terminal" });
  await copy.waitFor();
  const lines = await copy.getAttribute("title");
  assert.match(lines, /^cd ".*"\nclaude "Read \.cantus\/cache\/session-task\.md and do the task it describes\."$/);
});

test("the form of a new block sends its first work to the lead, or does not offer it: the map starts no agent", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const withLead = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await withLead.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(withLead.url);
  await page.waitForSelector(".chip.live");
  await page.evaluate(() => sessionStorage.setItem("cantus-edit", "1"));
  await page.reload();
  await page.waitForSelector(".chip.live");
  await page.locator(".card.ghost").first().click();
  assert.equal(await page.locator("#canvas form select").count(), 0, "no choice of a separate session");
  assert.equal(await page.locator("#canvas form textarea").count(), 1);
  await withLead.close();
  const without = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  t.after(() => without.close());
  await page.goto(without.url);
  await page.waitForSelector(".chip.live");
  await page.evaluate(() => sessionStorage.setItem("cantus-edit", "1"));
  await page.reload();
  await page.waitForSelector(".chip.live");
  await page.locator(".card.ghost").first().click();
  assert.equal(await page.locator("#canvas form textarea").count(), 0, "no session, nowhere to send it");
});

test("the states come from what the lead did, not from how long it was silent", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const base = git(root, "rev-parse", "main");
  const servers = [];
  const minutes = (n) => new Date(Date.now() - n * 60000).toISOString();
  // A worktree with a lead open on it, heard `ago` minutes back doing `via`; `report` makes it say it is done on the commit it is at.
  const lead = async (name, { via, ago = 1, report = false, commitAfter = false }) => {
    const folder = `${root}-${name}`;
    git(root, "worktree", "add", "-q", "-b", `feature/${name}`, folder);
    registerWorktree(root, { path: folder, branch: `feature/${name}`, base, task: `t-${name}`, session: true, prompt: `Task ${name}`, createdAt: new Date().toISOString() });
    fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), `\nexport const ${name.replace(/\W/g, "")} = 1;\n`);
    git(folder, "commit", "-qam", name);
    if (report) assert.equal(finishWorktree(folder, { summary: `Done ${name}` }).ok, true);
    if (commitAfter) {
      fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), "\nexport const later = 2;\n");
      git(folder, "commit", "-qam", "later");
    }
    const server = await startMapServer(new ProjectState(folder), { port: 0, pollInterval: 100, session: true });
    servers.push(server);
    if (via) touchPeer(folder, server.url, minutes(ago), process.pid, via);
  };
  await lead("tool", { via: "tool", ago: 5 });
  await lead("stop-bare", { via: "stop" });
  await lead("stop-reported", { via: "stop", report: true });
  await lead("stop-later", { via: "stop", report: true, commitAfter: true });
  await lead("prompt-after", { via: "prompt", report: true });
  await lead("never", {});
  await lead("lost", { via: "tool", ago: 20 });
  await lead("asks", { via: "permission", ago: 1 });
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await main.close(); for (const server of servers) await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn").click();
  await page.locator("#worktree-column .wtc").nth(8).waitFor();
  const standing = async (name) => page.locator(`#worktree-column .wtc[data-branch="feature/${name}"]`).locator(".wtc-state").innerText();
  const verifyButton = (name) => page.locator(`#worktree-column .wtc[data-branch="feature/${name}"]`).locator("button", { hasText: "Copy the verify command" });

  assert.equal(await standing("tool"), "working", "five minutes of silence in the middle of a turn is a test run, not a lead waiting");
  assert.match(await standing("stop-bare"), /^waiting for you/, "its turn ended and it reported nothing");
  assert.equal(await verifyButton("stop-bare").count(), 0);
  assert.match(await standing("stop-reported"), /^to review/);
  assert.equal(await verifyButton("stop-reported").getAttribute("title"), `cantus verify -C "${root}-stop-reported"`, "to review, with its lead still open");
  assert.match(await standing("stop-later"), /^waiting for you/, "a commit came after the report: it is not about the work as it stands");
  assert.equal(await verifyButton("stop-later").count(), 0);
  assert.equal(await standing("prompt-after"), "working", "a new message after the report: it is at work again");
  assert.equal(await standing("never"), "just opened");
  assert.match(await standing("lost"), /^waiting for you · silent for 2\d min/);
  assert.match(await standing("asks"), /^asking for a permission/, "it showed the person a prompt and nothing came after: it is the person's turn");
});

test("the card of a worktree says who wrote the files, with no alarm, and says nothing without the record", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const base = git(root, "rev-parse", "main");
  const make = (name) => {
    const folder = `${root}-${name}`;
    git(root, "worktree", "add", "-q", "-b", `feature/${name}`, folder);
    registerWorktree(root, { path: folder, branch: `feature/${name}`, base, task: `t-${name}`, session: true, prompt: `Task ${name}`, createdAt: new Date().toISOString() });
    fs.appendFileSync(path.join(folder, "src/pricing/index.ts"), `\nexport const ${name} = 1;\n`);
    git(folder, "commit", "-qam", name);
    return folder;
  };
  const written = make("written");
  fs.mkdirSync(path.join(written, ".cantus/cache"), { recursive: true });
  const edit = (file, agent) => JSON.stringify({ t: new Date().toISOString(), kind: "edit", phase: "after", file, ...(agent ? { agent } : {}), broken: 0 });
  fs.writeFileSync(path.join(written, ".cantus/cache/usage.jsonl"), [edit("a.ts"), edit("b.ts"), ...["1", "2", "3", "4", "5"].map((n) => edit(`p${n}.ts`, "block-pricing"))].join("\n") + "\n");
  assert.equal(finishWorktree(written, { summary: "Done written" }).ok, true);
  const plain = make("plain");
  assert.equal(finishWorktree(plain, { summary: "Done plain" }).ok, true);
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, runner: idleRunner, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await main.close(); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn").click();
  await page.locator("#worktree-column .wtc").nth(2).waitFor();
  const card = (name) => page.locator(`#worktree-column .wtc[data-branch="feature/${name}"]`);
  assert.equal(await card("written").locator(".wtc-line", { hasText: "Written by" }).innerText(), "Written by: lead 2 files · block-pricing 5 files");
  assert.equal(await card("plain").locator(".wtc-line", { hasText: "Written by" }).count(), 0);
  assert.equal(await card("written").locator(".wtc-line", { hasText: "Written by" }).getAttribute("class"), "wtc-line", "no warning class: it states a fact");
});

test("a terminal opened in a worktree: the app is the person's choice, the line is Cantus's own, and only a worktree of this repository", async (t) => {
  const root = shop();
  const other = `${root}-other`;
  git(root, "worktree", "add", "-q", "-b", "feature/other", other);
  talkedIn(other, "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab");
  const merged = `${root}-merged`;
  const base = git(root, "rev-parse", "main");
  git(root, "worktree", "add", "-q", "-b", "feature/merged", merged);
  fs.appendFileSync(path.join(merged, "src/orders/index.ts"), "\nexport const note = 1;\n");
  git(merged, "commit", "-qam", "note");
  git(root, "merge", "-q", "--no-ff", "--no-edit", "feature/merged");
  registerWorktree(root, { path: merged, branch: "feature/merged", base, task: "t-merged", session: true, prompt: "Note on orders", createdAt: new Date().toISOString() });
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  t.after(async () => { await main.close(); });
  const call = async (method, route, body) => {
    const response = await api(main, route, { method, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };

  const first = await call("GET", "api/personal/terminal");
  assert.equal(first.json.app, "lines");
  assert.deepEqual(first.json.apps.map((entry) => entry.app), ["lines", "warp", "wt"], "my own command is offered once the settings have one");
  assert.equal((await call("POST", "api/worktrees/open", { path: other })).status, 409, "the lines to copy are not run by Cantus");

  assert.equal((await call("PUT", "api/personal/terminal", { app: "custom" })).status, 400, "no command can be set from the page");
  assert.equal((await call("PUT", "api/personal/terminal", { app: "rm" })).status, 400);
  const marker = path.join(claudeHome, "opened.txt");
  const file = personalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ terminal: { command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], process.argv.slice(2).join('|'))", marker, "{folder}", "{claude}"] } }));
  assert.equal((await call("PUT", "api/personal/terminal", { app: "custom" })).status, 200);

  // Not this checkout (it is the one the person is in), not a folder that is no worktree of the repository.
  assert.equal((await call("POST", "api/worktrees/open", { path: root })).status, 404);
  assert.equal((await call("POST", "api/worktrees/open", { path: os.tmpdir() })).status, 404);
  assert.equal(fs.existsSync(marker), false);
  const run = await call("POST", "api/worktrees/open", { path: other });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fs.readFileSync(marker, "utf8"), `${other}|claude --resume 0b1c2d3e-aaaa-bbbb-cccc-1234567890ab`, "the folder, and the line that takes its conversation up");
  fs.rmSync(marker);
  const fresh = await call("POST", "api/worktrees/open", { path: merged });
  assert.equal(fresh.status, 404, "a merged one has nothing to take up");
  fs.rmSync(file);
});

test("the card offers the button for the app that was chosen, and the choice is made in the column", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const root = shop();
  const other = `${root}-other`;
  git(root, "worktree", "add", "-q", "-b", "feature/other", other);
  const file = personalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ terminal: { app: "warp" } }));
  const main = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100, session: true });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await main.close(); fs.rmSync(file, { force: true }); } });
  browser = await launchTestBrowser(chromium);
  const page = await browser.newPage();
  await page.goto(main.url);
  await page.waitForSelector(".chip.live");
  await page.locator("#sessions-btn").click();
  const card = page.locator('#worktree-column .wtc[data-branch="feature/other"]');
  await card.locator("button", { hasText: "Copy for the terminal" }).waitFor();
  await card.locator("button", { hasText: "Open in Warp" }).waitFor();
  assert.equal(await page.locator("#terminal-app").inputValue(), "warp");
  await page.locator("#terminal-app").selectOption("lines");
  await card.locator("button", { hasText: /^Open in/ }).waitFor({ state: "detached" });
  assert.equal(await card.locator("button", { hasText: /^Open in/ }).count(), 0, "with the lines to copy, Cantus opens nothing");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).terminal.app, "lines", "kept in the person's own settings");
});
