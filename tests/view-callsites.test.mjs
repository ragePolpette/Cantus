import { launchTestBrowser } from "./helpers.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectState, analyze, buildViewData, renderViewHtml, startMapServer } from "../dist/index.js";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = undefined;
}

/** A library block with one export and an app block that calls it from `callers` files, `calls` times each; one more block calls it once. */
function project(callers, calls) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-callsites-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("lib/index.ts", "export function work(n: number): number { return n + 1; }\n");
  for (let i = 0; i < callers; i++) {
    const body = Array.from({ length: calls }, (_, call) => `  total += work(${i + call});`).join("\n");
    write(`app/file${i}.ts`, `import { work } from "../lib/index";\nexport function run${i}(): number {\n  let total = 0;\n${body}\n  return total;\n}\n`);
  }
  write("tool/one.ts", `import { work } from "../lib/index";\nexport const once = work(1);\n`);
  const model = {
    version: 1,
    name: "callsites",
    blocks: [
      { id: "lib", name: "Library", layer: "domain", include: ["lib"] },
      { id: "app", name: "Application", layer: "application", include: ["app"] },
      { id: "tool", name: "Tooling", layer: "application", include: ["tool"] },
    ],
    dependencies: [{ from: "app", to: "lib" }, { from: "tool", to: "lib" }],
  };
  return { root, model };
}

test("the page carries the call sites it can show, and counts the rest", () => {
  const { root, model } = project(45, 2);
  const analysis = analyze(root, { model, skipGit: true });
  const data = buildViewData(analysis, model, []);
  const all = analysis.callSites.filter((site) => site.block && site.targetBlock && site.block !== site.targetBlock);
  assert.equal(all.length, 45 * 2 + 1);
  assert.equal(data.callSiteCounts.lib.all, 91, "every call site into the block is counted");
  assert.equal(data.callSiteCounts.lib.from.app, 90);
  assert.equal(data.callSiteCounts.lib.from.tool, 1);
  assert.equal(data.callSites.filter((site) => site.block === "app").length, 30, "thirty per pair of blocks");
  assert.equal(data.callSites.filter((site) => site.block === "tool").length, 1);
  assert.ok(JSON.stringify(data.callSites).length < JSON.stringify(all).length / 2, "the page is lighter");
});

test("a pair with few call sites is carried whole, in the order of the analysis", () => {
  const { root, model } = project(5, 1);
  const analysis = analyze(root, { model, skipGit: true });
  const data = buildViewData(analysis, model, []);
  const all = analysis.callSites.filter((site) => site.block && site.targetBlock && site.block !== site.targetBlock);
  assert.deepEqual(data.callSites, all);
  assert.deepEqual(data.callSiteCounts.lib, { all: 6, from: { app: 5, tool: 1 } });
});

test("the panel says how many call sites a block has and how many it does not list", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const { root, model } = project(45, 2);
  const html = renderViewHtml(buildViewData(analyze(root, { model, skipGit: true }), model, []));
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await new Promise((resolve) => server.close(resolve)); } });
  browser = await launchTestBrowser(chromium);
  const p = await (await browser.newContext({ locale: "en-US" })).newPage();
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.locator(".card", { hasText: "Library" }).first().click();
  const panel = await p.locator("#panel").textContent(); // textContent: the lists are folded and the headings are capitals by style
  assert.match(panel, /91 call sites/i, "the block's total, not the listed ones");
  assert.match(panel, /Application uses work \(90\)/, "the pair's total");
  assert.match(panel, /… 60 more/, "what the list does not show");
  assert.match(panel, /Tooling uses work \(1\)/);
});

test("a live page is light, and the panel of a block asks for its call sites and the neighbors' contracts", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const { root, model } = project(45, 2);
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const p = await (await browser.newContext({ locale: "en-US" })).newPage();
  const requests = [];
  p.on("request", (request) => { if (request.url().includes("/api/panel")) requests.push(request.url()); });
  await p.goto(server.url);
  await p.waitForSelector(".chip.live");
  const embedded = await p.evaluate(() => JSON.parse(document.getElementById("data").textContent));
  assert.deepEqual(embedded.callSites, []);
  assert.deepEqual(embedded.contracts, {});
  assert.equal(embedded.callSiteCounts.lib.all, 91, "the counts are in the page");

  // The library is used by two blocks and uses none: its callers are asked for.
  await p.locator(".card", { hasText: "Library" }).first().click();
  // The briefing the agent gets is behind a fold, left open from then on.
  await p.locator("#briefing > summary").click();
  await p.locator("#panel summary", { hasText: "Application uses work (90)" }).click();
  await p.waitForSelector("#panel .diag");
  assert.equal(await p.locator("#panel details:not(#briefing)", { hasText: "Application uses work" }).locator(".diag").count(), 30);
  assert.match(await p.locator("#panel").textContent(), /… 60 more/);
  assert.equal(requests.length, 1);

  // The application uses the library: its contract is asked for.
  await p.locator(".card", { hasText: "Application" }).first().click();
  await p.waitForFunction(() => document.querySelector("#panel pre")?.textContent.includes("work"));
  assert.match(await p.locator("#panel pre").first().textContent(), /export declare function work/);
  assert.equal(requests.length, 2);

  // Back to the library: not asked again.
  await p.locator(".card", { hasText: "Library" }).first().click();
  await p.waitForSelector("#panel .diag", { state: "attached" });
  assert.equal(requests.length, 2);
});

test("the server answers /api/panel for a known block only", async (t) => {
  const { root, model } = project(3, 1);
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = JSON.parse(html.match(/<script type="application\/json" id="live">(.*?)<\/script>/s)?.[1] ?? "{}").token;
  assert.ok(token, "the page carries its token");
  const ask = (block) => fetch(new URL(`/api/panel?block=${block}`, server.url), { headers: { "x-cantus-token": token } });
  const lib = await (await ask("lib")).json();
  assert.equal(lib.callSites.length, 4);
  assert.deepEqual(lib.contracts, {});
  const app = await (await ask("app")).json();
  assert.deepEqual(Object.keys(app.contracts), ["lib/index.ts"]);
  assert.equal((await ask("nothing")).status, 404);
  assert.equal((await fetch(new URL("/api/panel?block=lib", server.url))).status, 403);
});
