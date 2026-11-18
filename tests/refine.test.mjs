import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, applyRefinement, blocksToRefine, buildContextPack, describeNotes, describeRefinement, parseRefinement, refineBatches, refinePrompt, renderContextPrompt, requestRefinement, writeNotes } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/** The shop as `analyze --write` leaves it: folder names, no descriptions, one block unassigned. */
function rawShop() {
  const model = shopModel();
  model.blocks = model.blocks.map(({ id, include, layer }) => ({ id, name: { "src-db": "Db" }[id] ?? include[0].split("/").pop().replace(/^./, (c) => c.toUpperCase()), layer: id === "src-pricing" ? "unassigned" : layer, include }));
  model.blocks.find((block) => block.id === "src-orders").description = "Mine: orders and their lifecycle.";
  model.blocks.find((block) => block.id === "src-web").name = "Storefront";
  return model;
}

function mapped(model = rawShop()) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  return { root, model, analysis: analyze(root, { model }) };
}

const ANSWER = {
  blocks: [
    {
      id: "src-checkout",
      name: "Checkout flow",
      description: "Turns a cart into a paid order.\nSecond line dropped.",
      notes: [
        { text: "  The cart total is computed   in cart.ts only. ", files: ["./src/checkout/cart.ts"] },
        { text: "Payments go through Stripe.", files: ["src/payments/stripe.ts"] },
        { text: "Invented file.", files: ["src/checkout/ghost.ts"] },
        { text: "No evidence.", files: [] },
      ],
    },
    { id: "src-pricing", description: "Prices and discounts.", layer: "domain" },
    { id: "src-orders", name: "Order book", description: "Theirs.", layer: "nowhere" },
    { id: "src-web", name: "Web shop", layer: "domain", notes: [{ text: "Entry page.", files: ["src/web/checkout-page.ts"] }] },
    { id: "src-db", description: "Not asked." },
  ],
  suggestions: [{ block: "src-checkout", kind: "split", text: "Cart and payment are two jobs." }, { block: "src-gone", kind: "merge", text: "Unknown block." }],
};

test("a refinement is read from the agent's answer", () => {
  assert.deepEqual(parseRefinement("Done.\n```json\n" + JSON.stringify(ANSWER) + "\n```"), ANSWER);
  assert.throws(() => parseRefinement("They look fine."), /did not answer with a refinement/);
  assert.throws(() => parseRefinement('```json\n{"blocks": [{"description": "x"}]}\n```'), /not in the expected shape: blocks\.0\.id/);
  assert.throws(() => parseRefinement('```json\n{"blocks": [], "suggestions": [{"kind": "rewrite", "text": "x"}]}\n```'), /suggestions\.0\.kind/);
});

test("a refinement writes words only where it may, and never the analysis's facts", () => {
  const { model, analysis } = mapped();
  const asked = ["src-checkout", "src-orders", "src-pricing", "src-web"];
  const result = applyRefinement(model, analysis, ANSWER, asked);
  const block = (id) => result.model.blocks.find((candidate) => candidate.id === id);

  assert.equal(block("src-checkout").name, "Checkout flow", "a name taken from the folder may be replaced");
  assert.equal(block("src-checkout").description, "Turns a cart into a paid order.", "one line");
  assert.deepEqual(block("src-checkout").notes, [{ text: "The cart total is computed in cart.ts only.", files: ["src/checkout/cart.ts"] }]);
  assert.equal(block("src-pricing").layer, "domain", "an unassigned block gets a layer of the map");
  assert.equal(block("src-orders").name, "Order book", "so may the generated one of a block you described");
  assert.equal(block("src-orders").description, "Mine: orders and their lifecycle.", "a description you wrote stays");
  assert.equal(block("src-orders").layer, "domain");
  assert.equal(block("src-web").name, "Storefront", "a name you gave stays");
  assert.equal(block("src-web").layer, "interface", "a layer you chose stays");
  assert.deepEqual(block("src-web").notes, [{ text: "Entry page.", files: ["src/web/checkout-page.ts"] }]);
  assert.equal(block("src-db").description, undefined, "blocks not asked for are left alone");
  assert.equal(block("src-db").refined, undefined);

  assert.deepEqual(result.model.dependencies, model.dependencies, "the arrows are the analysis's");
  assert.deepEqual(result.model.blocks.map((candidate) => candidate.include), model.blocks.map((candidate) => candidate.include), "so are the paths");
  assert.deepEqual(block("src-checkout").refined.fields, ["description", "name", "notes"]);
  assert.match(block("src-orders").refined.fingerprint, /^[0-9a-f]{16}$/, "a block asked for is marked even when nothing was written");
  assert.deepEqual(block("src-orders").refined.fields, ["name"]);

  const reasons = result.rejected.map((entry) => `${entry.block} ${entry.what}: ${entry.reason.split(":")[0]}`);
  assert.deepEqual(reasons.sort(), [
    "src-checkout note: names files that are not in the block (src/checkout/ghost.ts)",
    "src-checkout note: names files that are not in the block (src/payments/stripe.ts)",
    "src-checkout note: names no file of the block",
    "src-db block: not one of the blocks asked for",
    "src-orders description: you described this block",
    "src-orders layer: \"nowhere\" is not one of the map's layers",
    "src-web layer: you placed this block in \"interface\"",
    "src-web name: you named this block",
  ]);
  assert.deepEqual(result.suggestions, [ANSWER.suggestions[0]], "suggestions about unknown blocks are dropped; none is applied");
});

test("a later refine rewrites what refine wrote, and keeps the edits you made", () => {
  const { model, analysis } = mapped();
  const first = applyRefinement(model, analysis, ANSWER, ["src-checkout", "src-pricing"]).model;
  const edited = structuredClone(first);
  const checkout = edited.blocks.find((block) => block.id === "src-checkout");
  checkout.name = "My checkout";
  checkout.refined.fields = checkout.refined.fields.filter((field) => field !== "name");
  const second = applyRefinement(edited, analysis, {
    blocks: [
      { id: "src-checkout", name: "Checkout", description: "Takes payment for a cart.", notes: [{ text: "Ghost only.", files: ["src/checkout/ghost.ts"] }] },
      { id: "src-pricing", layer: "infrastructure" },
    ],
  }, ["src-checkout", "src-pricing"]).model;
  const block = (id) => second.blocks.find((candidate) => candidate.id === id);
  assert.equal(block("src-checkout").name, "My checkout", "a field taken out of refined.fields is yours");
  assert.equal(block("src-checkout").description, "Takes payment for a cart.", "refine's own description is rewritten");
  assert.equal(block("src-checkout").notes, undefined, "refine's notes go when none of the new ones holds up");
  assert.deepEqual(block("src-checkout").refined.fields, ["description"]);
  assert.equal(block("src-pricing").layer, "infrastructure", "a layer refine chose may change again");

  const handNotes = structuredClone(model);
  handNotes.blocks.find((block) => block.id === "src-checkout").notes = [{ text: "Mine.", files: ["src/checkout/index.ts"] }];
  const kept = applyRefinement(handNotes, analysis, ANSWER, ["src-checkout"]);
  assert.deepEqual(kept.model.blocks.find((block) => block.id === "src-checkout").notes, [{ text: "Mine.", files: ["src/checkout/index.ts"] }]);
  assert.ok(kept.rejected.some((entry) => entry.what === "notes" && /you wrote this block's notes/.test(entry.reason)));
  const many = applyRefinement(model, analysis, { blocks: [{ id: "src-checkout", notes: Array.from({ length: 7 }, (_, i) => ({ text: `Note ${i}.`, files: ["src/checkout/cart.ts"] })) }] }, ["src-checkout"]);
  assert.equal(many.model.blocks.find((block) => block.id === "src-checkout").notes.length, 5);
  assert.equal(many.rejected.filter((entry) => /more than 5 notes/.test(entry.reason)).length, 2);
});

test("only blocks new or changed since the last refine are refined again", () => {
  const { root, model, analysis } = mapped();
  assert.equal(blocksToRefine(analysis, model).length, 6, "never refined: all of them");
  const refined = applyRefinement(model, analysis, { blocks: [] }, blocksToRefine(analysis, model)).model;
  assert.deepEqual(blocksToRefine(analysis, refined), []);
  assert.equal(blocksToRefine(analysis, refined, { all: true }).length, 6);
  assert.deepEqual(blocksToRefine(analysis, refined, { only: ["src-db"] }), ["src-db"]);
  assert.throws(() => blocksToRefine(analysis, refined, { only: ["src-nope"] }), /Unknown block\(s\): src-nope/);

  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport function vat(amount: number): number { return amount * 0.22; }\n");
  fs.writeFileSync(path.join(root, "src/db/pool.ts"), "export const size = 4;\n");
  assert.deepEqual(blocksToRefine(analyze(root, { model: refined }), refined).sort(), ["src-db", "src-pricing"], "a new export or a new file marks the block");
});

test("the prompt carries the analysis in neutral terms and asks only for words", () => {
  const { model, analysis } = mapped();
  const prompt = refinePrompt(analysis, model, ["src-checkout"]);
  assert.match(prompt, /### `src-checkout` — Checkout \(application\)/);
  assert.match(prompt, /Files \(2\): src\/checkout\/cart\.ts, src\/checkout\/index\.ts/);
  assert.match(prompt, /Uses: .*Orders/);
  assert.match(prompt, /- `src-orders` Orders \(domain, 1 files\): src\/orders — Mine: orders and their lifecycle\./, "every block for orientation");
  assert.doesNotMatch(prompt, /### `src-orders`/, "only the batch is refined");
  assert.match(prompt, /your answer cannot change them/);
});

/** A stand-in for Claude Code that tries a write and a read, then answers with `answer`. */
function refiningRunner(answer, seen = {}) {
  return (request) => ({
    async *[Symbol.asyncIterator]() {
      seen.prompt = request.prompt;
      seen.maxTurns = request.maxTurns;
      seen.write = await request.canUseTool("Edit", { file_path: "x" }, request.abort.signal);
      seen.read = await request.canUseTool("Grep", { pattern: "x" }, request.abort.signal);
      yield { type: "result", ok: true, text: answer };
    },
  });
}

test("the refining agent reads the project and changes nothing", async () => {
  const { root, model, analysis } = mapped();
  const seen = {};
  const refinement = await requestRefinement(refiningRunner("```json\n" + JSON.stringify(ANSWER) + "\n```", seen), { cwd: root, analysis, map: model, blocks: ["src-checkout"] });
  assert.deepEqual(refinement, ANSWER);
  assert.equal(seen.read.allow, true);
  assert.equal(seen.write.allow, false);
  assert.equal(seen.maxTurns, 40);
  assert.match(seen.prompt, /### `src-checkout`/);
});

test("notes reach the block's notes file and its briefing", () => {
  const { root, model, analysis } = mapped();
  const refined = applyRefinement(model, analysis, ANSWER, ["src-checkout"]).model;
  const current = analyze(root, { model: refined });
  writeNotes(current, refined);
  const notes = fs.readFileSync(path.join(root, "src/checkout/AGENTS.md"), "utf8");
  assert.match(notes, /Turns a cart into a paid order\.\n\nHow to work here:\n- The cart total is computed in cart\.ts only\. \(`src\/checkout\/cart\.ts`\)/);
  const briefing = renderContextPrompt(buildContextPack(current, "src-checkout", refined), { root });
  assert.match(briefing, /How to work here:\n- The cart total is computed in cart\.ts only\./);
});

function runnerModule(answer) {
  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-runner-")), "runner.mjs");
  fs.writeFileSync(file, `export default (request) => {\n  async function* run() {\n    yield { type: "result", ok: true, text: ${JSON.stringify("```json\n" + JSON.stringify(answer) + "\n```")}, costUsd: 0.25 };\n  }\n  const iterator = run();\n  return { [Symbol.asyncIterator]: () => iterator, async setPermissionMode() {} };\n};\n`);
  return file;
}

test("CLI: cantus refine saves the map, reports what it left out, and then has nothing to do", () => {
  const { root } = mapped();
  const run = (...args) => spawnSync(process.execPath, [cli, "refine", ...args, "-C", root], { encoding: "utf8" });
  const runner = runnerModule(ANSWER);
  const first = run("--runner", runner);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Estimated cost: \$0\.25 \(1 session\)\./);
  assert.match(first.stdout, /Refined 6 block\(s\): \d+ field\(s\) written, \d+ left out\./);
  assert.match(first.stdout, /src-checkout note: names files that are not in the block \(src\/checkout\/ghost\.ts\)/);
  assert.match(first.stdout, /Suggestions \(not applied[^\n]*\n  \[split\] \([0-9a-f]{6}\) src-checkout: Cart and payment are two jobs\./);
  const saved = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
  assert.equal(saved.blocks.find((block) => block.id === "src-checkout").description, "Turns a cart into a paid order.");
  assert.equal(saved.blocks.find((block) => block.id === "src-db").description, "Not asked.", "in one batch every block is asked for");

  const again = run("--runner", runner);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Every block is refined and unchanged since/);
  const json = run("src-db", "--json", "--runner", runner);
  assert.deepEqual(JSON.parse(json.stdout).blocks, ["src-db"]);
  assert.equal(JSON.parse(json.stdout).costUsd, 0.25);

  const bare = copyFixture("shop");
  const unmapped = spawnSync(process.execPath, [cli, "refine", "-C", bare], { encoding: "utf8" });
  assert.equal(unmapped.status, 2);
  assert.match(unmapped.stderr, /No map saved yet/);
});

test("Python blocks are refined like any other: signatures in the prompt, notes checked against .py files", () => {
  const root = copyFixture("python");
  const first = analyze(root, { skipGit: true });
  const model = { version: 1, name: first.name, blocks: first.blocks.map((info) => info.block), dependencies: first.dependencies.map((dep) => ({ from: dep.from, to: dep.to })), rules: { allow: {} } };
  const analysis = analyze(root, { model, skipGit: true });

  const prompt = refinePrompt(analysis, model, ["src-shop-orders"]);
  assert.match(prompt, /Files \(2\): src\/shop\/orders\/__init__\.py, src\/shop\/orders\/service\.py/);
  assert.match(prompt, /`src\/shop\/orders\/service\.py`: `def create_order\(items: list\[float\], customer: str, \*, discount: float = 0\) -> dict`/);
  assert.match(prompt, /Uses: Db, Pricing\. Used by: .*Api/);

  const result = applyRefinement(model, analysis, {
    blocks: [{ id: "src-shop-orders", description: "Places orders.", notes: [{ text: "Orders are created through create_order.", files: ["src/shop/orders/service.py"] }, { text: "Ghost.", files: ["src/shop/orders/ghost.py"] }] }],
  }, ["src-shop-orders"]);
  const block = result.model.blocks.find((candidate) => candidate.id === "src-shop-orders");
  assert.deepEqual(block.notes, [{ text: "Orders are created through create_order.", files: ["src/shop/orders/service.py"] }]);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.model.dependencies, model.dependencies);

  const refreshed = analyze(root, { model: result.model, skipGit: true });
  assert.deepEqual(blocksToRefine(refreshed, result.model).sort(), blocksToRefine(refreshed, model).filter((id) => id !== "src-shop-orders").sort(), "a refined Python block is skipped until it changes");
  fs.appendFileSync(path.join(root, "src/shop/orders/service.py"), "\n\ndef cancel_order(order: dict) -> dict:\n    return {**order, \"status\": \"cancelled\"}\n");
  assert.ok(blocksToRefine(analyze(root, { model: result.model, skipGit: true }), result.model).includes("src-shop-orders"), "a new function marks the block");
});

test("text longer than the map keeps is cut after its last whole sentence, not thrown away; the prompt states the limit", () => {
  const { model, analysis } = mapped();
  assert.match(refinePrompt(analysis, model, ["src-checkout"]), /At most 300 characters: one or two short sentences/);
  assert.match(refinePrompt(analysis, model, ["src-checkout"]), /Each note is at most 300 characters/);

  const sentence = (n) => `Sentence number ${n} says something about checkout.`;
  const long = [1, 2, 3, 4, 5, 6, 7, 8].map(sentence).join(" ");
  assert.ok(long.length > 300);
  const answer = { blocks: [{ id: "src-checkout", description: long, notes: [{ text: long, files: ["src/checkout/cart.ts"] }] }] };
  const result = applyRefinement(model, analysis, answer, ["src-checkout"]);
  const block = result.model.blocks.find((candidate) => candidate.id === "src-checkout");
  assert.equal(block.description, [1, 2, 3, 4, 5, 6].map(sentence).join(" "), "cut after the last sentence that fits in 300");
  assert.equal(block.notes[0].text, block.description);
  assert.deepEqual(result.shortened.map((entry) => `${entry.what}:${entry.from}`), [`description:${long.length}`, `note:${long.length}`]);
  assert.deepEqual(result.rejected, []);
  assert.match(describeRefinement(result, 1), /Cut after the last sentence that fit .*src-checkout description/);

  const oneRun = { blocks: [{ id: "src-checkout", description: "x".repeat(400), notes: [{ text: "y".repeat(400), files: ["src/checkout/cart.ts"] }] }] };
  const rejected = applyRefinement(model, analysis, oneRun, ["src-checkout"]);
  assert.deepEqual(rejected.rejected.map((entry) => entry.what), ["description", "note"], "no sentence ends within the limit: left out");
  assert.match(rejected.rejected[0].reason, /no sentence ends within them/);
});

test("a layer that would break the layer rules is not written: it becomes a suggestion", () => {
  const { model, analysis } = mapped();
  const prompt = refinePrompt(analysis, model, ["src-pricing"]);
  assert.match(prompt, /Layer rules \(a block may depend on blocks in\): host → anything; interface → interface, application, domain; application → application, domain, infrastructure;/);

  // Checkout (application) uses Pricing: Pricing in the interface layer would break application → interface.
  const bad = applyRefinement(model, analysis, { blocks: [{ id: "src-pricing", layer: "interface" }] }, ["src-pricing"]);
  assert.equal(bad.model.blocks.find((block) => block.id === "src-pricing").layer, "unassigned");
  assert.deepEqual(bad.applied.filter((entry) => entry.field === "layer"), []);
  assert.match(bad.rejected[0].reason, /"interface" 1 arrow\(s\) would break the layer rules: src-checkout \(application\) → src-pricing \(interface\): left as it is/);
  assert.deepEqual(bad.suggestions.map((entry) => `${entry.kind} ${entry.block}`), ["layer src-pricing"]);
  assert.match(describeRefinement(bad, 1), /\[layer\] \([0-9a-f]{6}\) src-pricing: The agent proposed "interface"/);

  const good = applyRefinement(model, analysis, { blocks: [{ id: "src-pricing", layer: "domain" }] }, ["src-pricing"]);
  assert.equal(good.model.blocks.find((block) => block.id === "src-pricing").layer, "domain");
  assert.deepEqual(good.suggestions, []);
});

test("blocks of one project are refined together, in sessions of at most eight", () => {
  const blocks = [];
  for (const project of ["alpha", "beta", "gamma"]) {
    for (let i = 0; i < 5; i++) blocks.push({ id: `${project}-m${i}`, name: `${project} m${i}`, layer: "domain", include: [`apps/${project}/m${i}`] });
  }
  const analysis = { blocks: blocks.map((block) => ({ block, files: ["x"] })) };
  // alphabetical by id would cut alpha|beta in the middle of beta; here a project is never split when it fits
  const ids = blocks.map((block) => block.id).reverse();
  const batches = refineBatches(analysis, ids, 8);
  assert.deepEqual(batches.map((batch) => batch.length), [5, 5, 5]);
  for (const batch of batches) assert.equal(new Set(batch.map((id) => id.split("-")[0])).size, 1);
  const small = refineBatches(analysis, ids.slice(0, 3).concat(ids.slice(5, 7)), 8);
  assert.equal(small.length, 1);
  // a project bigger than a session is cut, in order
  const big = { blocks: Array.from({ length: 11 }, (_, i) => ({ block: { id: `b${i}`, name: `B${i}`, layer: "x", include: [`p/b${String(i).padStart(2, "0")}`] }, files: ["x"] })) };
  assert.deepEqual(refineBatches(big, big.blocks.map((b) => b.block.id), 8).map((batch) => batch.length), [8, 3]);
});

test("a rename keeps the prefix of the sibling blocks, and the prompt names the language", () => {
  const { model, analysis } = mapped();
  const family = { ...model, blocks: model.blocks.map((block) => (block.id.match(/^src-(checkout|pricing|orders)$/) ? { ...block, name: `Shop · ${block.name}` } : block)) };
  const result = applyRefinement(family, analysis, { blocks: [{ id: "src-checkout", name: "Cart · Payment flow" }, { id: "src-pricing", name: "Shop · Prices" }] }, ["src-checkout", "src-pricing"]);
  assert.equal(result.model.blocks.find((block) => block.id === "src-checkout").name, "Shop · Payment flow");
  assert.equal(result.model.blocks.find((block) => block.id === "src-pricing").name, "Shop · Prices");

  assert.match(refinePrompt(analysis, model, ["src-checkout"], { language: "Italian" }), /Language of names, descriptions and notes: Italian\./);
  assert.match(refinePrompt(analysis, model, ["src-checkout"]), /the language of these existing descriptions \("Mine: orders/);
  const fresh = { ...model, blocks: model.blocks.map(({ description, ...block }) => block) };
  assert.match(refinePrompt(analysis, fresh, ["src-checkout"]), /language of the project's comments and docs/);
});

test("refine rewrites the notes of the blocks it refined only, and says which files are new", () => {
  const { root, analysis, model } = mapped();
  writeNotes(analysis, model); // the project opted in: the root pointer carries the markers
  const before = fs.readdirSync(path.join(root, "src/db")).includes("AGENTS.md");
  assert.equal(before, true);
  fs.rmSync(path.join(root, "src/pricing/AGENTS.md"));
  const run = spawnSync(process.execPath, [cli, "refine", "src-checkout,src-pricing", "-C", root, "--runner", runnerModule({ blocks: [{ id: "src-checkout", description: "Turns a cart into a paid order." }, { id: "src-pricing", description: "Prices and discounts." }] })], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Notes: 2 updated \(src\/checkout\/AGENTS\.md, AGENTS\.md\), 1 created \(src\/pricing\/AGENTS\.md\)/);
  assert.doesNotMatch(run.stderr, /src\/db/);
  assert.equal(describeNotes({ written: ["a/AGENTS.md", "b/AGENTS.md"], created: ["b/AGENTS.md"], unchanged: [], skipped: [] }), "1 updated (a/AGENTS.md), 1 created (b/AGENTS.md)");
});
