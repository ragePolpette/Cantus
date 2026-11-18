import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { analyze, buildViewData, renderViewHtml } from "../dist/index.js";
import { LANGUAGES } from "../dist/outputs/i18n/index.js";
import { fixtures, shopModel, launchTestBrowser } from "./helpers.mjs";
import { renderMsg } from "../dist/analysis/message.js";
import { check } from "../dist/index.js";
import { analysisTemplates, pageMessages, slotsOf } from "./i18n-keys.mjs";

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

function script() {
  return page().match(/<script>([\s\S]*?)<\/script>/)[1];
}

/** What a language has to translate: the texts of the page, and the templates the analysis writes its findings from. */
function messagesToTranslate() {
  return new Map([...pageMessages(script()).keys, ...analysisTemplates()]);
}

test("every text of the page is a literal that the languages can translate", () => {
  const { keys, dynamic } = pageMessages(script());
  assert.deepEqual(dynamic, [], "tr()/trn() take their texts as string literals, so a language can be checked against them");
  assert.ok(keys.size > 300);
  for (const [key, { kind }] of keys) {
    if (kind === "trn") assert.equal(key.split("|").length, 2, `a count message has a singular and a plural: ${key}`);
  }
});

for (const language of LANGUAGES) {
  test(`${language.name}: translates every message of the page, and only those`, () => {
    const keys = messagesToTranslate();
    const missing = [...keys.keys()].filter((key) => !(key in language.messages));
    assert.deepEqual(missing, [], `messages without a line in ${language.code}`);
    const stale = Object.keys(language.messages).filter((key) => !keys.has(key));
    assert.deepEqual(stale, [], `lines of ${language.code} that the page no longer asks for`);
  });

  test(`${language.name}: lines keep the {slots} of the English text and counts have an "other" form`, () => {
    for (const [key, { kind, slots }] of messagesToTranslate()) {
      const line = language.messages[key];
      assert.deepEqual(slotsOf(line), [...slots].sort(), `slots of "${key}"`);
      if (kind === "msg") {
        assert.ok(typeof line === "string" || typeof line.other === "string", `"${key}" is a line or has the "other" form`);
      } else if (kind === "trn") {
        assert.equal(typeof line, "object", `a count needs plural forms: "${key}"`);
        assert.equal(typeof line.other, "string", `"${key}" needs the "other" form`);
      } else {
        assert.equal(typeof line, "string", `"${key}" is a single line`);
      }
      for (const text of typeof line === "string" ? [line] : Object.values(line)) assert.ok(text.trim().length > 0, `"${key}" is not empty`);
    }
  });
}

test("no text is left in the script outside tr() and trn()", () => {
  const source = script().replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const { keys } = pageMessages(source);
  const keyed = new Set([...keys.keys()].flatMap((key) => key.split("|")));
  // Class names, commands and the prompt sent to the agent session are not text for the person.
  const code = /^(dot|line|badge|chip|card|sub|finding|tag|text|gap|diag) |^(Enter|Escape|WorktreeSetup)$|^cantus[ -]|^#canvas|^About $|^ in the working tree$/;
  const bare = [];
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const text = JSON.parse(`"${match[1]}"`);
    if (keyed.has(text) || code.test(text)) continue;
    if (/^[A-Z][a-z]{2,}/.test(text) || /[a-z]{3,} [a-z]{2,}/i.test(text)) bare.push(text);
  }
  assert.deepEqual(bare, [], "wrap these in tr() or trn()");
});

test("the page carries its languages, and the selector lists them", () => {
  const html = page();
  const payload = JSON.parse(html.match(/<script type="application\/json" id="i18n">(.*?)<\/script>/s)[1]);
  assert.deepEqual(payload.source, { code: "en", name: "English" });
  assert.deepEqual(payload.languages.map((l) => l.code), LANGUAGES.map((l) => l.code));
  assert.ok(Object.keys(payload.messages.it).length > 300);
});

async function serve(html) {
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the page follows the browser's language, and the selector changes and remembers it", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const server = await serve(page());
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);

  const italian = await browser.newContext({ locale: "it-IT" });
  const p = await italian.newPage();
  await p.goto(server.url);
  assert.equal(await p.locator("html").getAttribute("lang"), "it");
  assert.match(await p.locator("#facts .fact").first().innerText(), /^\d+ blocchi$/);
  assert.match(await p.locator("#legend").innerText(), /allineato al modello/);
  assert.equal(await p.locator("#legend").isVisible(), false, "the legend is behind the ? in the bottom bar");
  assert.equal(await p.locator("#lang").inputValue(), "it");

  await p.locator("#settings-btn").click();
  await p.selectOption("#lang", "en");
  await p.waitForFunction(() => document.documentElement.lang === "en");
  assert.match(await p.locator("#facts .fact").first().innerText(), /^\d+ blocks$/);
  assert.match(await p.locator("#legend").innerText(), /aligned with the model/);
  await p.reload();
  assert.equal(await p.locator("html").getAttribute("lang"), "en", "the choice is kept");

  // A language the page does not have falls back to English.
  const german = await browser.newContext({ locale: "de-DE" });
  const q = await german.newPage();
  await q.goto(server.url);
  assert.equal(await q.locator("html").getAttribute("lang"), "en");
  assert.match(await q.locator("#facts .fact").first().innerText(), /^\d+ blocks$/);
});

test("the explanations Cantus prints are the ones the page translates", async () => {
  const { EXPLANATIONS } = await import("../dist/analysis/explain.js");
  const { keys } = pageMessages(script());
  for (const [code, text] of Object.entries(EXPLANATIONS)) {
    for (const [field, value] of Object.entries({ title: text.title, why: text.why, action: text.action })) assert.ok(keys.has(value), `${code} ${field} is not a page message: ${value}`);
  }
});

test("the analysis chip opens the problems by cause, with a way to open the file", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const analysis = analyze(path.join(fixtures, "shop"), { model: shopModel(), skipGit: true });
  analysis.diagnostics.push(
    { level: "error", stage: "parse", file: "src/orders/index.ts", line: 3, column: 1, message: "Unexpected token" },
    { level: "warning", stage: "contracts", file: "src/pricing/index.ts", line: 2, message: "typescript@6.0.3 TS7006: Parameter 'p' implicitly has an 'any' type." },
  );
  const server = await serve(renderViewHtml(buildViewData(analysis, shopModel(), [])));
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  browser = await launchTestBrowser(chromium);
  const context = await browser.newContext({ locale: "it-IT" });
  const p = await context.newPage();
  await p.goto(server.url);
  // The Signals button counts it; the panel lists it with a way to the problems.
  assert.match(await p.locator("#signals-btn").getAttribute("title"), /1 problema d'analisi da guardare/);
  await p.locator("#signals-btn").click();
  const panel = p.locator("#panel");
  assert.match(await panel.locator("#signal-problems h4").textContent(), /^1 problema d'analisi da guardare$/);
  await panel.locator("#signal-problems a", { hasText: "Apri l'elenco" }).click();
  assert.match(await panel.innerText(), /Da correggere nel tuo codice/i);
  assert.match(await panel.innerText(), /Codice che non si può leggere/i);
  assert.match(await panel.innerText(), /src\/orders\/index\.ts:3:1/);
  assert.match(await panel.innerText(), /Limiti di Cantus, niente da fare/i);
  assert.equal(await p.locator("#panel details").first().getAttribute("open"), null, "Cantus's limits are folded");
});

test("a finding says its message from a template, and carries it out of the way of JSON", () => {
  const analysis = analyze(path.join(fixtures, "shop"), { model: shopModel(), skipGit: true });
  const findings = check(analysis, shopModel());
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.ok(finding.msg, `${finding.kind} has its template`);
    assert.equal(renderMsg(finding.msg), finding.message, "the English is the template filled in");
    assert.equal("msg" in JSON.parse(JSON.stringify(finding)), false, "printed findings stay as they were");
  }
  const data = buildViewData(analysis, shopModel(), findings);
  assert.ok(data.findings.every((finding) => finding.msg), "the page gets the template");
});

/** Every template of the analysis as a finding, with a stand-in for each slot, for the page to say. */
function templateFindings(n) {
  return [...analysisTemplates().entries()].map(([template, { slots }], index) => {
    const p = Object.fromEntries(slots.map((slot) => [slot, slot === "n" ? n : `~${slot}~`]));
    const m = { t: template, p };
    return { kind: "cycle", severity: "info", message: renderMsg(m), msg: m, blocks: [], index };
  });
}

test("the page says every finding template in English as the analysis does, and in Italian without losing a value", { skip: !chromium && "Playwright is not installed" }, async (t) => {
  const browser = await launchTestBrowser(chromium);
  t.after(async () => { await browser.close(); });
  for (const n of [1, 2]) {
    const analysis = analyze(path.join(fixtures, "shop"), { model: shopModel(), skipGit: true });
    // The findings of a real project (whose slots may be empty), and every template with its slots filled.
    const findings = [...check(analysis, shopModel()).map((finding) => ({ ...finding, msg: finding.msg })), ...templateFindings(n)];
    const data = buildViewData(analysis, shopModel(), []);
    data.findings = findings;
    const server = await serve(renderViewHtml(data));
    try {
      const shown = {};
      for (const locale of ["en-US", "it-IT"]) {
        const context = await browser.newContext({ locale });
        const p = await context.newPage();
        await p.goto(server.url);
        await p.waitForSelector("#panel li.text", { state: "attached" });
        shown[locale] = await p.locator("#panel li.text").evaluateAll((items) => items.map((item) => item.textContent));
        await context.close();
      }
      assert.equal(shown["en-US"].length, findings.length);
      const label = (text, locale) => text.replace(/^\[[^\]]+\] /, "");
      findings.forEach((finding, i) => {
        // The list is in the order given.
        assert.equal(label(shown["en-US"][i]), finding.message, `English, n=${n}`);
        const italian = label(shown["it-IT"][i]);
        if (LANGUAGES[0].messages[finding.msg.t] !== finding.msg.t) assert.notEqual(italian, finding.message, `translated: ${finding.msg.t}`);
        assert.ok(!/\{\w+\}/.test(italian), `no slot left open: ${italian}`);
        if (finding.index !== undefined) for (const slot of Object.keys(finding.msg.p)) if (slot !== "n") assert.ok(italian.includes(`~${slot}~`), `${slot} is kept: ${italian}`);
      });
    } finally {
      await server.close();
    }
  }
});
