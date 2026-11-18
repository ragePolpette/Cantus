import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addBlock, analyze, moveToBlock, splitBlock } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

async function connect(t, root) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root, "--no-ui"], stderr: "pipe" }));
  t.after(() => client.close());
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
}

const saved = (root) => JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
function mappedShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  return root;
}
const owners = (analysis) => Object.fromEntries(analysis.blocks.flatMap((info) => info.files.map((file) => [file, info.block.id])));
const filesOf = (analysis, id) => analysis.blocks.find((info) => info.block.id === id).files;

test("a split takes files or a subfolder out of a block into a new one; the files follow the longest path", () => {
  const root = mappedShop();
  const model = shopModel();
  const analysis = analyze(root, { model, cache: false });
  const split = splitBlock(model, "src-checkout", { name: "Cart", files: ["src/checkout/cart.ts"] }, filesOf(analysis, "src-checkout"));
  assert.equal(split.id, "cart");
  assert.deepEqual(split.moved, ["src/checkout/cart.ts"]);
  assert.deepEqual(split.model.blocks.find((block) => block.id === "cart"), { id: "cart", name: "Cart", layer: "application", include: ["src/checkout/cart.ts"] });
  assert.deepEqual(split.model.blocks.find((block) => block.id === "src-checkout").include, ["src/checkout"]);
  const after = analyze(root, { model: split.model, cache: false });
  assert.deepEqual(filesOf(after, "cart"), ["src/checkout/cart.ts"]);
  assert.deepEqual(filesOf(after, "src-checkout"), ["src/checkout/index.ts"]);

  const error = (draft, from = "src-checkout") => assert.throws(() => splitBlock(model, from, draft, filesOf(analysis, from)));
  error({ name: "All", files: ["src/checkout/cart.ts", "src/checkout/index.ts"] });
  error({ name: "Nothing", files: ["src/orders/index.ts"] });
  error({ name: "Neither" });
  error({ name: "Both", files: ["src/checkout/cart.ts"], folder: "src/checkout" });
  error({ name: "Src checkout", files: ["src/checkout/cart.ts"] });
  error({ name: "", files: ["src/checkout/cart.ts"] });
  error({ name: "Empty folder", folder: "src/checkout/nope" });
  assert.throws(() => splitBlock(model, "src-nope", { name: "X", files: ["a"] }, []), /No block/);
});

test("a subfolder splits off as a path, and a folder the block listed whole leaves its list", () => {
  const model = { ...shopModel(), blocks: shopModel().blocks.map((block) => (block.id === "src-checkout" ? { ...block, include: ["src/checkout", "src/payments"] } : block.id === "src-payments" ? { ...block, include: ["src/payments-old"] } : block)) };
  const split = splitBlock(model, "src-checkout", { name: "Pay", folder: "src/payments", layer: "infrastructure" }, ["src/checkout/cart.ts", "src/payments/stripe.ts"]);
  assert.deepEqual(split.model.blocks.find((block) => block.id === "src-checkout").include, ["src/checkout"]);
  assert.deepEqual(split.model.blocks.find((block) => block.id === "pay"), { id: "pay", name: "Pay", layer: "infrastructure", include: ["src/payments"] });
});

test("files move to another block as paths of their own; a block that listed them stops; an emptied block is refused", () => {
  const root = mappedShop();
  const model = shopModel();
  const analysis = analyze(root, { model, cache: false });
  const moved = moveToBlock(model, ["src/checkout/cart.ts"], "src-pricing", owners(analysis));
  assert.deepEqual(moved.moved, ["src/checkout/cart.ts"]);
  assert.deepEqual(moved.from, ["src-checkout"]);
  assert.deepEqual(moved.model.blocks.find((block) => block.id === "src-pricing").include, ["src/pricing", "src/checkout/cart.ts"]);
  const after = analyze(root, { model: moved.model, cache: false });
  assert.deepEqual(filesOf(after, "src-pricing").sort(), ["src/checkout/cart.ts", "src/pricing/index.ts"]);

  // Back again: the block that listed the file by name stops listing it.
  const back = moveToBlock(moved.model, ["src/checkout/cart.ts"], "src-checkout", owners(after));
  assert.deepEqual(back.model.blocks.find((block) => block.id === "src-pricing").include, ["src/pricing"]);
  assert.ok(back.model.blocks.find((block) => block.id === "src-checkout").include.includes("src/checkout/cart.ts"));

  assert.deepEqual(moveToBlock(model, ["src/checkout/cart.ts"], "src-checkout", owners(analysis)).moved, [], "already there");
  assert.throws(() => moveToBlock(model, ["src/orders/index.ts"], "src-pricing", owners(analysis)), /all the files of `src-orders`/);
  assert.throws(() => moveToBlock(model, ["src/nope.ts"], "src-pricing", owners(analysis)), /in no block/);
  assert.throws(() => moveToBlock(model, ["src/checkout/cart.ts"], "src-nope", owners(analysis)), /split_block/);
});

test("add_block refuses a folder that already has code, and says what to do instead", () => {
  const root = mappedShop();
  const model = shopModel();
  const analysis = analyze(root, { model, cache: false });
  const files = analysis.blocks.flatMap((info) => info.files);
  assert.throws(() => addBlock(model, { name: "Cart", layer: "application", path: "src/checkout/cart.ts" }, files), /already has code \(1 file\).*split_block/);
  assert.throws(() => addBlock(model, { name: "Sub", layer: "application", path: "src/checkout/index.ts" }, files), /already has code/);
  assert.equal(addBlock(model, { name: "Wishlist", layer: "domain" }, files).id, "src-wishlist");
});

test("split_block and move_to_block change the saved map and report it", async (t) => {
  const root = mappedShop();
  fs.writeFileSync(path.join(root, "src/checkout/extra.ts"), "export const extra = 1;\n");
  const call = await connect(t, root);
  const split = await call("split_block", { block: "src-checkout", name: "Cart", files: ["src/checkout/cart.ts"] });
  assert.match(split.text, /Split `cart` \(Cart\) off `src-checkout`: 1 file/);
  assert.deepEqual(saved(root).blocks.find((block) => block.id === "cart").include, ["src/checkout/cart.ts"]);
  assert.match((await call("block_context", { block: "cart" })).text, /cart\.ts/);

  const moved = await call("move_to_block", { files: ["src/checkout/extra.ts"], into: "cart" });
  assert.match(moved.text, /Moved 1 file from `src-checkout` to `cart`/);
  assert.deepEqual(saved(root).blocks.find((block) => block.id === "cart").include, ["src/checkout/cart.ts", "src/checkout/extra.ts"]);
  assert.match((await call("move_to_block", { files: ["src/checkout/extra.ts"], into: "cart" })).text, /Already in `cart`/);

  const emptied = await call("move_to_block", { files: ["src/checkout/index.ts"], into: "cart" });
  assert.equal(emptied.isError, true);
  assert.match(emptied.text, /all the files of `src-checkout`/);
  assert.equal((await call("split_block", { block: "src-checkout", name: "Everything", folder: "src/checkout" })).isError, true);
  const code = await call("add_block", { name: "Cart again", layer: "application", folder: "src/checkout/index.ts" });
  assert.equal(code.isError, true);
  assert.match(code.text, /already has code.*split_block/);
});
