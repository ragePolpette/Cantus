import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, check, describeNotes, NOTES_END, NOTES_START, scaffold, updateMap, writeNotes } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

test("updating the map keeps what people wrote and adds what the code shows", () => {
  const root = copyFixture("shop");
  const model = { ...shopModel(), blocks: shopModel().blocks.filter((block) => block.id !== "src-db") };
  model.blocks[0].description = "The storefront.";
  const update = updateMap(root, analyze(root, { model, skipGit: true }), model);
  assert.deepEqual(update.addedBlocks, ["src-db"]);
  assert.equal(update.model.blocks[0].description, "The storefront.");
  assert.equal(update.model.blocks.find((block) => block.id === "src-web").layer, "interface");
  const after = analyze(root, { model: update.model, skipGit: true });
  assert.deepEqual(check(after, update.model).filter((finding) => finding.kind === "undeclared-dependency"), []);

  const fresh = updateMap(root, analyze(root, { skipGit: true }));
  assert.equal(fresh.created, true);
  assert.equal(fresh.model.blocks.length, 6);
});

test("block notes go into AGENTS.md, or CLAUDE.md when the folder has one, and keep human text", () => {
  const root = copyFixture("shop");
  fs.writeFileSync(path.join(root, "src/orders/AGENTS.md"), "# Orders\n\nNever delete orders: mark them cancelled.\n");
  fs.writeFileSync(path.join(root, "src/pricing/CLAUDE.md"), "# Pricing\n\nPrices are in cents.\n");
  const analysis = analyze(root, { model: shopModel(), skipGit: true });

  const first = writeNotes(analysis);
  assert.ok(first.written.includes("src/orders/AGENTS.md"));
  assert.ok(first.written.includes("src/pricing/CLAUDE.md"));
  assert.ok(!fs.existsSync(path.join(root, "src/pricing/AGENTS.md")), "a CLAUDE.md in the folder takes the notes, since Claude Code then skips AGENTS.md");
  assert.ok(first.written.includes("AGENTS.md"), "root pointer");

  const orders = fs.readFileSync(path.join(root, "src/orders/AGENTS.md"), "utf8");
  assert.ok(orders.startsWith("# Orders\n\nNever delete orders: mark them cancelled.\n"));
  assert.match(orders, /## Block `src-orders` — Orders \(domain\)/);
  assert.match(orders, /- Used by: Checkout \(`src-checkout`: Order, createOrder\)\./);
  assert.match(orders, /- Uses: Database \(`src-db`: db\)\./);
  assert.equal(orders.split(NOTES_START).length, 2);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /- `src-orders` \(domain\): src\/orders/);

  const second = writeNotes(analysis);
  assert.deepEqual(second.written, [], "deterministic: nothing changes on a second run");

  fs.writeFileSync(path.join(root, "src/orders/AGENTS.md"), orders.replace(NOTES_END, `${NOTES_END}\n\nMore human notes.`));
  writeNotes(analysis);
  assert.match(fs.readFileSync(path.join(root, "src/orders/AGENTS.md"), "utf8"), /<!-- cantus:end -->\n\nMore human notes\.\n$/);
});

test("with a CLAUDE.md at the root, the notes stay in AGENTS.md and each block folder's CLAUDE.md only imports them", () => {
  const root = copyFixture("shop");
  fs.writeFileSync(path.join(root, "src/orders/AGENTS.md"), "# Orders\n\nNever delete orders: mark them cancelled.\n");
  fs.writeFileSync(path.join(root, "src/db/CLAUDE.md"), "# Db\n\nMigrations are forward only.\n");
  const analysis = analyze(root, { model: shopModel(), skipGit: true });
  writeNotes(analysis);
  assert.ok(!fs.existsSync(path.join(root, "src/pricing/CLAUDE.md")), "no stub while the root has no CLAUDE.md");

  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Shop\n");
  const result = writeNotes(analysis);
  assert.ok(result.written.includes("CLAUDE.md"), "root pointer in the root CLAUDE.md");
  assert.equal(fs.readFileSync(path.join(root, "src/pricing/CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(fs.readFileSync(path.join(root, "src/pricing/AGENTS.md"), "utf8"), /## Block `src-pricing`/);
  assert.match(fs.readFileSync(path.join(root, "src/orders/AGENTS.md"), "utf8"), /^# Orders\n\nNever delete orders: mark them cancelled\.\n[\s\S]*## Block `src-orders`/, "human text and notes stay together");
  assert.equal(fs.readFileSync(path.join(root, "src/orders/CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  const db = fs.readFileSync(path.join(root, "src/db/CLAUDE.md"), "utf8");
  assert.match(db, /Migrations are forward only\.[\s\S]*## Block `src-db`/, "a CLAUDE.md with text of its own keeps the notes");
  assert.ok(!fs.existsSync(path.join(root, "src/db/AGENTS.md")));
  assert.deepEqual(result.removed, []);
  assert.deepEqual(writeNotes(analysis).written, [], "deterministic");
});

test("notes an older run put in a block's CLAUDE.md move back to AGENTS.md, and what was emptied is reported as removed", () => {
  const root = copyFixture("shop");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Shop\n");
  const analysis = analyze(root, { model: shopModel(), skipGit: true });
  writeNotes(analysis);
  const agents = path.join(root, "src/pricing/AGENTS.md");
  const generated = fs.readFileSync(agents, "utf8");
  // What 0.3 did: the generated notes in CLAUDE.md, an AGENTS.md left with the heading only.
  fs.writeFileSync(path.join(root, "src/pricing/CLAUDE.md"), generated);
  fs.writeFileSync(agents, generated.slice(0, generated.indexOf(NOTES_START)).trim() + "\n");
  const result = writeNotes(analysis);
  assert.equal(fs.readFileSync(path.join(root, "src/pricing/CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(fs.readFileSync(agents, "utf8"), /## Block `src-pricing`/);
  assert.ok(result.written.includes("src/pricing/CLAUDE.md") && result.written.includes("src/pricing/AGENTS.md"));
  assert.deepEqual(writeNotes(analysis).written, []);
  assert.match(describeNotes({ written: [], created: [], removed: ["a/AGENTS.md"], unchanged: [], skipped: [] }), /1 removed/);
});

test("scaffold turns a design into a map and contract files, never overwriting", () => {
  const root = copyFixture("mono");
  fs.rmSync(path.join(root, "packages"), { recursive: true });
  const design = {
    name: "notes",
    blocks: [
      { name: "API", layer: "interface", path: "src/api", description: "HTTP routes", contract: 'import type { Note } from "../notes/index.js";\nexport declare function listNotes(): Promise<Note[]>;' },
      { name: "Notes", layer: "domain", path: "src/notes/", description: "Note rules", contract: "export interface Note { id: string; text: string }" },
    ],
    dependencies: [{ from: "src/api", to: "src/notes" }, { from: "src/api", to: "src/missing" }],
  };
  const result = scaffold(root, design);
  assert.deepEqual(result.created, ["src/api/index.ts", "src/notes/index.ts"]);
  assert.deepEqual(result.model.dependencies, [{ from: "src-api", to: "src-notes" }]);
  assert.deepEqual(scaffold(root, design).skipped, ["src/api/index.ts", "src/notes/index.ts"]);
  const model = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
  const analysis = analyze(root, { model, skipGit: true });
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to}`), ["src-api->src-notes"]);
});

test("a new folder next to existing blocks becomes a block, even inside a catch-all block", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  model.blocks.push({ id: "src", name: "Everything else", layer: "unassigned", include: ["src"] });
  fs.mkdirSync(path.join(root, "src/coupons"));
  fs.writeFileSync(path.join(root, "src/coupons/index.ts"), 'import { quote } from "../pricing/index.js";\nexport const couponTotal = (items: Array<{ quantity: number; unitPrice: number }>): number => quote(items) * 0.9;\n');
  const update = updateMap(root, analyze(root, { model, skipGit: true }), model);
  assert.deepEqual(update.addedBlocks, ["src-coupons"]);
  assert.deepEqual(update.addedDependencies, [{ from: "src-coupons", to: "src-pricing" }, { from: "src-web", to: "src-db" }]);
});

test("the root pointer lists the blocks of a small map, and only points to `map` for a large one", () => {
  const root = copyFixture("shop");
  const analysis = analyze(root, { model: shopModel(), skipGit: true });
  const many = { ...analysis, blocks: Array.from({ length: 16 }, (_, index) => ({ ...analysis.blocks[0], block: { ...analysis.blocks[0].block, id: `extra-${index}`, include: [`nowhere/${index}`] } })) };
  writeNotes(many);
  const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(text, /split into 16 blocks/);
  assert.doesNotMatch(text, /- `extra-0`/);
  assert.match(text, /not repeated here/);
});

test("a block's notes name only a few exports per arrow and a dozen arrows, with the rest counted", () => {
  const root = copyFixture("shop");
  const analysis = analyze(root, { model: shopModel(), skipGit: true });
  const target = analysis.blocks.find((info) => info.block.id === "src-pricing");
  const others = analysis.blocks.filter((info) => info.block.id !== "src-pricing");
  const symbols = Array.from({ length: 40 }, (_, index) => `Export${index}`);
  const fat = {
    ...analysis,
    blocks: [...analysis.blocks, ...Array.from({ length: 14 }, (_, index) => ({ ...others[0], block: { ...others[0].block, id: `user-${index}`, include: [`nowhere/${index}`] } }))],
    dependencies: Array.from({ length: 14 }, (_, index) => ({ from: `user-${index}`, to: "src-pricing", symbols })),
  };
  writeNotes(fat, undefined, { only: ["src-pricing"] });
  const text = fs.readFileSync(path.join(root, "src/pricing/AGENTS.md"), "utf8");
  assert.match(text, /Export4, … \+35 more/);
  assert.doesNotMatch(text, /Export5\b/);
  assert.match(text, /\+2 more blocks/);
  assert.ok(target);
});
