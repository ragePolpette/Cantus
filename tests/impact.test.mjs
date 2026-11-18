import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildViewData } from "../dist/index.js";
import { readChanges } from "../dist/state/changes.js";
import { apiChanges } from "../dist/state/impact.js";
import { renderReview } from "../dist/mcp/server.js";
import { copyFixture, shopModel } from "./helpers.mjs";

function committedShop() {
  const root = copyFixture("shop");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  commit("init");
  // pricing and checkout usually change together.
  for (let i = 1; i <= 3; i++) {
    fs.appendFileSync(path.join(root, "src/pricing/index.ts"), `// ${i}\n`);
    fs.appendFileSync(path.join(root, "src/checkout/cart.ts"), `// ${i}\n`);
    commit(`pricing ${i}`);
  }
  return root;
}

test("the uncommitted work: exports changed, removed and added, and the call sites in other blocks", () => {
  const root = committedShop();
  const pricing = path.join(root, "src/pricing/index.ts");
  fs.writeFileSync(pricing, fs.readFileSync(pricing, "utf8")
    .replace("export function quote(items: Array<{ quantity: number; unitPrice: number }>): number {", "export function quote(items: Array<{ quantity: number; unitPrice: number }>, vat: number): number {")
    .replace("export function discount(total: number) {", "function discount(total: number) {")
    + "export function roundCents(value: number): number {\n  return Math.round(value * 100) / 100;\n}\n");
  // A file mid-edit (syntax error) is left out rather than misread.
  fs.appendFileSync(path.join(root, "src/orders/index.ts"), "export function broken( {\n");

  const model = shopModel();
  const analysis = analyze(root, { model });
  const changes = readChanges(root);
  const api = apiChanges(root, analysis, changes);
  assert.deepEqual(api.map((change) => `${change.kind} ${change.name} ${change.callers.length}`), ["changed quote 1", "removed discount 0", "added roundCents 0"]);
  assert.match(api[0].before, /quote\(items: Array<\{\s*quantity: number;\s*unitPrice: number;?\s*\}>\): number/);
  assert.match(api[0].after, /vat: number/);
  assert.equal(api[0].callers[0].file, "src/checkout/index.ts");

  const review = renderReview(analysis, changes, api);
  assert.match(review, /^# Changes since the last commit: 2 file\(s\), \+\d+ −\d+/);
  assert.match(review, /- Pricing \(`src-pricing`\): `src\/pricing\/index\.ts` \(\+\d+ −\d+\)/);
  assert.match(review, /- `quote` changed in `src\/pricing\/index\.ts`: `[^`]+` → `[^`]+vat[^`]+`\. 1 call site\(s\) in other blocks: src\/checkout\/index\.ts:\d+\./);
  assert.match(review, /- `discount` was removed from `src\/pricing\/index\.ts`\. no call site in other blocks\./);
  assert.match(review, /## New exports\n\n- `roundCents` in `src\/pricing\/index\.ts` \(src-pricing\)/);
  assert.match(review, /## Usually changed together, not this time\n\n- `src\/pricing\/index\.ts` usually changes with `src\/checkout\/cart\.ts` \(3 commits\), which is unchanged\./);

  const view = buildViewData(analysis, model, [], changes);
  assert.deepEqual(view.apiChanges.map((change) => `${change.kind} ${change.name} ${change.callerCount}`), ["changed quote 1", "removed discount 0", "added roundCents 0"]);
  assert.deepEqual(Object.keys(view.apiChanges[0].callers[0]).sort(), ["block", "file", "line", "match"]);
});

test("the review is quiet about co-change when the file's exports did not change, and names new constants instead of asking to check them", () => {
  const root = committedShop();
  const pricing = path.join(root, "src/pricing/index.ts");
  // A body-only edit: same exports.
  fs.writeFileSync(pricing, fs.readFileSync(pricing, "utf8").replace("export function discount(total: number) {", "export function discount(total: number) {\n  // reviewed"));
  let analysis = analyze(root, { model: shopModel() });
  let changes = readChanges(root);
  let review = renderReview(analysis, changes, apiChanges(root, analysis, changes));
  assert.doesNotMatch(review, /Usually changed together/);

  fs.appendFileSync(pricing, "export const TAX_RATE = 0.22;\nexport const ROUNDING = 2;\nexport function roundCents(value: number): number {\n  return value;\n}\n");
  analysis = analyze(root, { model: shopModel() });
  changes = readChanges(root);
  review = renderReview(analysis, changes, apiChanges(root, analysis, changes));
  assert.match(review, /## New exports\n\n- `roundCents` in/);
  assert.doesNotMatch(review, /- `TAX_RATE` in/);
  assert.match(review, /Also 2 new constant\(s\) or variable\(s\): `ROUNDING`, `TAX_RATE`\./);
  assert.match(review, /## Usually changed together, not this time/, "exports changed: the partner is worth a look");
});

test("nothing to review: no changes, or no git", () => {
  const root = committedShop();
  const analysis = analyze(root, { model: shopModel() });
  assert.equal(renderReview(analysis, readChanges(root), []), "No changes since the last commit.");
  const plain = copyFixture("shop");
  assert.match(renderReview(analyze(plain, { skipGit: true }), readChanges(plain), []), /Not a git repository/);
});

test("the map file is not code: it is said apart, never counted in a block", () => {
  const root = committedShop();
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const analysis = analyze(root, { model: shopModel() });
  const onlyMap = readChanges(root);
  assert.equal(onlyMap.mapChanged, true);
  assert.deepEqual(Object.keys(onlyMap.files).filter((file) => file.startsWith(".cantus/")), []);
  assert.match(renderReview(analysis, onlyMap, []), /^No code changes since the last commit\. The map \(`\.cantus\/model\.json`\) has changes not committed yet/);

  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "// note\n");
  const both = readChanges(root);
  const review = renderReview(analysis, both, apiChanges(root, analysis, both));
  assert.match(review, /^# Changes since the last commit: 1 file\(s\)/);
  assert.match(review, /\n\nThe map \(`\.cantus\/model\.json`\) has changes not committed yet/);
});
