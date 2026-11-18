import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  analyze,
  buildContextPack,
  buildViewData,
  check,
  renderContextPrompt,
  renderViewHtml,
} from "../dist/index.js";
import { copyFixture, fixtures, shopModel } from "./helpers.mjs";

const shop = path.join(fixtures, "shop");

test("a block's context holds its own code, neighbor contracts and dependents", () => {
  const model = shopModel();
  const analysis = analyze(shop, { model, skipGit: true });
  const pack = buildContextPack(analysis, "src-checkout", model, check(analysis, model));

  assert.deepEqual(pack.files.map((file) => file.path), ["src/checkout/cart.ts", "src/checkout/index.ts"]);
  assert.deepEqual(pack.neighbors.map((neighbor) => neighbor.block.id), ["src-orders", "src-payments", "src-pricing"]);
  assert.deepEqual(pack.dependents.map((dependent) => dependent.block.id), ["src-web"]);
  assert.deepEqual(pack.dependents[0].files, ["src/checkout/index.ts"]);
  assert.ok(pack.ownedTokens + pack.contractTokens < pack.repoTokens);

  const prompt = renderContextPrompt(pack, { root: shop });
  assert.match(prompt, /export async function placeOrder/, "owned implementation is inlined");
  assert.match(prompt, /export declare function createOrder/, "neighbor contract is included");
  assert.doesNotMatch(prompt, /ORDERS_INTERNAL_42/, "neighbor implementation is not visible");
  assert.doesNotMatch(prompt, /renderCheckout/, "dependent implementation is not visible");
});

test("declared dependencies without code yet still give the agent the target contract", () => {
  const model = shopModel();
  model.dependencies.push({ from: "src-pricing", to: "src-orders" });
  const analysis = analyze(shop, { model, skipGit: true });
  const pack = buildContextPack(analysis, "src-pricing", model);
  assert.equal(pack.neighbors.length, 1);
  assert.equal(pack.neighbors[0].declaredOnly, true);
  assert.match(pack.neighbors[0].declarations[0].text, /createOrder/);
  assert.deepEqual(pack.allowedDependencies.map((block) => block.id), ["src-orders"]);
});

test("a block's briefing carries its open findings", () => {
  const model = shopModel();
  const analysis = analyze(shop, { model, skipGit: true });
  const prompt = renderContextPrompt(buildContextPack(analysis, "src-web", model, check(analysis, model)), { root: shop });
  assert.match(prompt, /\[info\] Not on the map yet: Web imports Database/);
  assert.throws(() => buildContextPack(analysis, "nope", model), /Unknown block "nope"/);
});

test("the view embeds blocks, edge status and escapes script content", () => {
  const model = shopModel();
  model.blocks[0].description = "</script><script>alert(1)</script>";
  const analysis = analyze(shop, { model, skipGit: true });
  const findings = check(analysis, model);
  const data = buildViewData(analysis, model, findings);

  const edge = (from, to) => data.edges.find((candidate) => candidate.from === from && candidate.to === to).status;
  assert.equal(edge("src-web", "src-db"), "undeclared");
  assert.equal(edge("src-orders", "src-db"), "violation");
  assert.equal(edge("src-web", "src-checkout"), "ok");
  assert.equal(data.blocks.find((block) => block.id === "src-web").severity, "warning", "unmapped imports are information; the layer warning remains");
  assert.deepEqual(data.callSites.map((site) => `${site.block}->${site.targetBlock}:${site.symbol}`).sort(), [
    "src-checkout->src-orders:Order",
    "src-checkout->src-orders:createOrder",
    "src-checkout->src-payments:charge",
    "src-checkout->src-pricing:quote",
    "src-orders->src-db:db",
    "src-web->src-checkout:placeOrder",
    "src-web->src-db:db",
  ]);

  const html = renderViewHtml(data);
  assert.equal(html.match(/<\/script>/g).length, 5, "only the page's own script tags close (theme, data, live config, languages, code)");
  const json = html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(json).blocks.length, 6);
});

test("the briefing lists the backend endpoints the block calls", () => {
  const http = path.join(fixtures, "http");
  const analysis = analyze(http, { skipGit: true });
  const pack = buildContextPack(analysis, "src-ui");
  assert.deepEqual(pack.httpEndpoints, ["GET /api/catalog", "GET /api/search", "POST /api/catalog"]);
  const prompt = renderContextPrompt(pack, { root: http, inlineSources: false });
  assert.match(prompt, /Backend endpoints this block calls over HTTP/);
  assert.match(prompt, /`GET \/api\/catalog`, `GET \/api\/search`, `POST \/api\/catalog`/);
  const view = buildViewData(analysis, undefined, []);
  assert.deepEqual(view.blocks.find((b) => b.id === "src-lib").httpEndpoints, ["DELETE /api/items", "POST /api/upload"]);
});

test("a briefing over its token budget shrinks: the APIs used instead of whole contracts, then a cut", () => {
  const analysis = analyze(copyFixture("shop"), { model: shopModel(), skipGit: true });
  const pack = buildContextPack(analysis, "src-checkout", shopModel(), []);
  const render = (maxTokens) => renderContextPrompt(pack, { root: analysis.root, inlineSources: false, maxTokens });
  const tokens = (text) => Math.ceil(text.length / 4);
  assert.equal(render(10_000), renderContextPrompt(pack, { root: analysis.root, inlineSources: false }), "under budget: unchanged");

  const fullSize = tokens(render(10_000));
  const compact = render(fullSize - 100);
  assert.ok(tokens(compact) <= fullSize - 100);
  assert.match(compact, /- `src\/orders\/index\.ts:\d+`: `function createOrder\(id: string, total: number\): Order;`/, "the neighbor's API as the signatures used, with where they are");
  assert.match(compact, /The rest of its API: `find_api` with `block: "src-orders"`/);
  assert.doesNotMatch(compact, /```ts/, "no whole declaration files");
  assert.match(compact, /_This block is large: the briefing is shortened to fit about/);
  assert.match(compact, /\(the whole one would be about \d/, "it says how much the whole briefing would be");

  const cut = render(250);
  assert.ok(tokens(cut) <= 250);
  assert.match(cut, /_\[cut here\]_/);
  assert.match(cut, /^# Block: Checkout/, "what comes first is kept");
});

test("cantus context keeps large briefings within budget unless --full", () => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel()));
  // A neighbor with a big API: checkout's briefing would carry all of it.
  fs.writeFileSync(path.join(root, "src/pricing/big.ts"), Array.from({ length: 3000 }, (_, i) => `/** Rate number ${i}, documented at length so the briefing grows. */\nexport function rate${i}(amount: number): number { return amount * ${i}; }`).join("\n") + "\n");
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), 'export * from "./big.js";\n');
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const run = (...args) => spawnSync(process.execPath, [cli, "context", "src-checkout", "-C", root, ...args], { encoding: "utf8" }).stdout;
  const footer = spawnSync(process.execPath, [cli, "context", "src-checkout", "-C", root], { encoding: "utf8" }).stderr;
  assert.match(footer, /This briefing: ~\d+k? tokens\. The scope itself: own code ~/, "the footer says how big the briefing is, apart from what the scope holds");
  const budgeted = run();
  const full = run("--full");
  assert.ok(budgeted.length / 4 <= 14_500, `budgeted: ~${Math.round(budgeted.length / 4)} tokens`);
  assert.ok(full.length > budgeted.length * 2);
  assert.doesNotMatch(budgeted, /big\.ts:\d+/, "the neighbor's thousands of unused exports are counted, not listed");
  assert.match(budgeted, /It exports \d+ more in \d+ file\(s\), not shown: `find_api` with `block: "src-pricing"`/);
});

test("past ~4k tokens of neighbor files the briefing gives what the scope uses, with comment, line and named types", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  fs.writeFileSync(path.join(root, "src/pricing/index.ts"), [
    "export interface Quote { amount: number; currency: string }",
    "",
    "/**",
    " * Prices an order.",
    " * @example",
    " * quote(10)",
    " * @throws when the amount is negative",
    " */",
    "export function quote(amount: number): Quote { return { amount, currency: 'EUR' }; }",
    "",
    "export type Unrelated = string;",
    "",
    ...Array.from({ length: 400 }, (_, i) => `/** Rate number ${i}, documented at length so the file grows beyond the threshold. */\nexport function rate${i}(amount: number): number { return amount * ${i}; }`),
    "",
  ].join("\n"));
  const analysis = analyze(root, { model, skipGit: true });
  const pack = buildContextPack(analysis, "src-checkout", model, []);
  const tiered = renderContextPrompt(pack, { root, inlineSources: false });
  assert.match(tiered, /- `src\/pricing\/index\.ts:9`: `function quote\(amount: number\): Quote;`\n  Prices an order\.\n  @throws when the amount is negative/, "signature, line and the comment without its example");
  assert.doesNotMatch(tiered, /quote\(10\)/);
  assert.match(tiered, /Types those signatures name:\n\n- `src\/pricing\/index\.ts:1`: `interface Quote/);
  assert.doesNotMatch(tiered, /Unrelated|rate399/, "what the scope does not use is not listed");
  assert.match(tiered, /It exports \d+ more in 1 file\(s\), not shown/);
  assert.doesNotMatch(tiered, /```ts[\s\S]*rate399/);
  const whole = renderContextPrompt(pack, { root, inlineSources: false, neighborFiles: true });
  assert.match(whole, /rate399/, "neighborFiles gives the files whole");
  assert.ok(whole.length > tiered.length * 3);
});

test("neighbors show the declarations of the files used and count the rest, listing their names only on request", () => {
  const root = copyFixture("shop");
  fs.writeFileSync(path.join(root, "src/orders/refund.ts"), "export function refundOrder(id: string): boolean { return id.length > 0; }\nexport const REFUND_WINDOW_DAYS = 14;\n");
  const model = shopModel();
  const analysis = analyze(root, { model, skipGit: true });
  const pack = buildContextPack(analysis, "src-checkout", model, []);
  const others = pack.neighbors.flatMap((neighbor) => neighbor.otherExports);
  assert.deepEqual(others.map((entry) => entry.name).sort(), ["REFUND_WINDOW_DAYS", "refundOrder"]);

  const brief = renderContextPrompt(pack, { root, inlineSources: false });
  assert.doesNotMatch(brief, /refundOrder|REFUND_WINDOW_DAYS|refund\.ts/, "not listed by default");
  assert.match(brief, /Also exports 2 more in 1 file\(s\), not shown: `find_api` with `block: "src-orders"`/);
  assert.doesNotMatch(brief, /Also exported by that block/);

  const full = renderContextPrompt(pack, { root, inlineSources: false, fullNeighbors: true });
  assert.match(full, /Also exported by that block \(names only; signatures with `find_api` with `block: "src-orders"`\):\n- `src\/orders\/refund\.ts`: `REFUND_WINDOW_DAYS`, `refundOrder`/);
});
