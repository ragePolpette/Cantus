import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

test("an agent plans, edits and removes blocks and arrows through the tools, with the editor's checks", async (t) => {
  const root = mappedShop();
  const call = await connect(t, root);

  const added = await call("add_block", { name: "Wishlist", layer: "domain", description: "Saved items" });
  assert.match(added.text, /Added block `src-wishlist`.*planned: no code yet/);
  assert.deepEqual(saved(root).blocks.at(-1), { id: "src-wishlist", name: "Wishlist", layer: "domain", include: ["src/wishlist"], description: "Saved items" });
  assert.match((await call("map")).text, /## Wishlist \(`src-wishlist`, domain\)\nSaved items/);

  const refused = await call("add_block", { name: "Wishlist", layer: "domain" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /already a block `src-wishlist`/);
  assert.match((await call("add_block", { name: "X", layer: "nowhere" })).text, /unknown layer "nowhere"/);

  assert.match((await call("add_dependency", { from: "src-checkout", to: "src-wishlist" })).text, /`src-checkout` now uses `src-wishlist`/);
  assert.ok(saved(root).dependencies.some((dep) => dep.from === "src-checkout" && dep.to === "src-wishlist"));
  assert.equal((await call("add_dependency", { from: "src-checkout", to: "src-nope" })).isError, true);

  const moved = await call("edit_block", { block: "src-wishlist", name: "Saved", folder: "src/saved", description: "" });
  assert.match(moved.text, /Updated block `src-saved` \(it was `src-wishlist`\)/);
  assert.ok(saved(root).dependencies.some((dep) => dep.to === "src-saved"), "arrows follow the move");
  assert.equal((await call("edit_block", { block: "src-checkout", folder: "src/elsewhere" })).isError, true, "a block with code is not moved here");
  assert.equal((await call("edit_block", { block: "src-checkout", layer: "interface" })).isError, false);

  assert.equal((await call("remove_block", { block: "src-orders" })).isError, true, "a block with code stays");
  assert.match((await call("remove_dependency", { from: "src-checkout", to: "src-saved" })).text, /Removed the arrow/);
  assert.match((await call("remove_block", { block: "src-saved" })).text, /Removed block `src-saved`/);
  assert.ok(!saved(root).blocks.some((block) => block.id === "src-saved"));

  const layers = await call("set_layers", { layers: ["ui", "application", "domain"], renames: { interface: "ui" } });
  assert.match(layers.text, /Layers: ui, application, domain\. Now unassigned: src-payments, src-db/);
  assert.equal(saved(root).blocks.find((block) => block.id === "src-web").layer, "ui");
  assert.equal((await call("set_layers", { layers: ["a", "a"] })).isError, true);
});

test("a project without a map gets one from its code before the first edit", async (t) => {
  const root = copyFixture("shop");
  const call = await connect(t, root);
  assert.equal(fs.existsSync(path.join(root, ".cantus/model.json")), false);
  assert.equal((await call("add_block", { name: "Wishlist", layer: "domain" })).isError, false);
  const model = saved(root);
  assert.ok(model.blocks.length > 1, "the blocks the code already has are on the map");
  assert.ok(model.blocks.some((block) => block.id === "src-wishlist"));
});

test("merge_block folds a block with code into a neighbour: folders, arrows and groups follow", async (t) => {
  const root = mappedShop();
  const call = await connect(t, root);
  const before = saved(root);
  const users = before.dependencies.filter((dep) => dep.to === "src-pricing").map((dep) => dep.from);
  assert.ok(users.length > 0, "the fixture has a user of pricing");
  const merged = await call("merge_block", { block: "src-pricing", into: "src-orders" });
  assert.match(merged.text, /Merged `src-pricing` into `src-orders`/);
  const after = saved(root);
  assert.ok(!after.blocks.some((block) => block.id === "src-pricing"));
  assert.deepEqual(after.blocks.find((block) => block.id === "src-orders").include, ["src/orders", "src/pricing"]);
  assert.ok(!after.dependencies.some((dep) => dep.from === dep.to || dep.from === "src-pricing" || dep.to === "src-pricing"));
  for (const user of users.filter((id) => id !== "src-orders")) assert.ok(after.dependencies.some((dep) => dep.from === user && dep.to === "src-orders"), `${user} now uses orders`);
  assert.equal((await call("merge_block", { block: "src-orders", into: "src-orders" })).isError, true);
  assert.equal((await call("merge_block", { block: "src-nope", into: "src-orders" })).isError, true);
});
