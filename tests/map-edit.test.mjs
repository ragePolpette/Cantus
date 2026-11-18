import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectState, addBlock, addDependency, defaultBlockFolder, removeBlock, removeDependency, setLayers, startMapServer, updateBlock } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

test("layers are renamed, reordered and removed with their blocks and rules", () => {
  const model = shopModel();
  const next = setLayers(model, ["ui", "application", "domain"], { interface: "ui" });
  assert.deepEqual(next.layers, ["ui", "application", "domain"]);
  assert.equal(next.blocks.find((block) => block.id === "src-web").layer, "ui");
  assert.deepEqual(next.blocks.filter((block) => block.layer === "unassigned").map((block) => block.id), ["src-payments", "src-db"], "blocks of a removed layer become unassigned");
  assert.deepEqual(next.rules.allow, { ui: ["ui", "application", "domain"], application: ["application", "domain"], domain: ["domain"] });
  assert.throws(() => setLayers(model, ["a", "a"]), /listed twice/);
});

test("blocks are planned on the map, edited, and removed while they have no code", () => {
  const model = { ...shopModel(), groups: [{ id: "pay", name: "Pay", blocks: ["src-checkout"] }], docs: [{ path: "docs/x.md", blocks: ["src-checkout"] }] };
  assert.equal(defaultBlockFolder("Notes Store!"), "src/notes-store");
  const added = addBlock(model, { name: "Wishlist", layer: "domain", description: " Saved items " });
  assert.equal(added.id, "src-wishlist");
  assert.deepEqual(added.model.blocks.at(-1), { id: "src-wishlist", name: "Wishlist", layer: "domain", include: ["src/wishlist"], description: "Saved items" });
  assert.throws(() => addBlock(added.model, { name: "Wishlist", layer: "domain" }), /already a block `src-wishlist`/);
  assert.throws(() => addBlock(model, { name: "X", layer: "nowhere" }), /unknown layer "nowhere"/);
  assert.throws(() => addBlock(model, { name: "X", layer: "domain", path: "../outside" }), /not a folder inside the project/);

  const linked = addDependency(addDependency(added.model, "src-checkout", "src-wishlist"), "src-checkout", "src-wishlist");
  assert.equal(linked.dependencies.filter((dep) => dep.to === "src-wishlist").length, 1, "an arrow is added once");
  assert.throws(() => addDependency(linked, "src-checkout", "src-checkout"), /itself/);
  assert.throws(() => addDependency(linked, "src-checkout", "nope"), /must be blocks/);

  // A planned block can move to another folder: it gets a new id, and arrows follow.
  const moved = updateBlock(linked, "src-wishlist", { path: "src/saved", name: "Saved", description: "" }, false);
  assert.equal(moved.id, "src-saved");
  assert.deepEqual(moved.model.blocks.at(-1), { id: "src-saved", name: "Saved", layer: "domain", include: ["src/saved"] });
  assert.ok(moved.model.dependencies.some((dep) => dep.from === "src-checkout" && dep.to === "src-saved"));
  assert.throws(() => updateBlock(linked, "src-checkout", { path: "src/elsewhere" }, true), /already has code/);
  assert.equal(updateBlock(linked, "src-checkout", { layer: "interface" }, true).model.blocks.find((block) => block.id === "src-checkout").layer, "interface");

  assert.throws(() => removeBlock(moved.model, "src-checkout", true), /has code/);
  const without = removeBlock(moved.model, "src-saved", false);
  assert.ok(!without.blocks.some((block) => block.id === "src-saved"));
  assert.ok(!without.dependencies.some((dep) => dep.to === "src-saved"));
  // Removing the last block of a group drops the group, and a document assigned to nothing else.
  const lonely = removeBlock(model, "src-checkout", false);
  assert.deepEqual(lonely.groups, []);
  assert.deepEqual(lonely.docs, []);
  assert.deepEqual(removeDependency(linked, "src-checkout", "src-wishlist").dependencies, model.dependencies);
});

function call(server, method, pathname, body, token = server.token) {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...(token ? { "x-cantus-token": token } : {}) };
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); } catch { reject(new Error(`${method} ${pathname}: ${res.statusCode} ${raw.slice(0, 200)}`)); } });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("the live map edits the map file; an empty project gets a map to sketch on", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-empty-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());
  const read = () => JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));

  assert.equal((await call(server, "PUT", "/api/map/layers", { layers: ["ui", "core"] }, "")).status, 403, "the token is required");
  assert.equal((await call(server, "PUT", "/api/map/layers", { layers: ["ui", "core"] })).status, 200);
  assert.deepEqual(read().layers, ["ui", "core"]);
  const screens = await call(server, "POST", "/api/map/blocks", { name: "Screens", layer: "ui" });
  assert.deepEqual(screens.json, { ok: true, id: "src-screens" });
  await call(server, "POST", "/api/map/blocks", { name: "Store", layer: "core", description: "Keeps notes" });
  assert.equal((await call(server, "POST", "/api/map/dependencies", { from: "src-screens", to: "src-store" })).status, 200);
  assert.equal((await call(server, "POST", "/api/map/blocks", { name: "Bad", layer: "nowhere" })).status, 400);

  const view = (await call(server, "GET", "/api/view")).json;
  assert.deepEqual(view.allLayers, ["ui", "core"]);
  assert.deepEqual(view.edges, [{ from: "src-screens", to: "src-store", symbols: [], status: "planned", declared: true }]);
  assert.ok(!fs.existsSync(path.join(root, "src")), "folders appear only when an agent writes there");

  // Code arrives in the store: it can no longer be removed or moved from the map.
  fs.mkdirSync(path.join(root, "src/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/store/index.ts"), "export const notes: string[] = [];\n");
  assert.match((await call(server, "DELETE", "/api/map/blocks/src-store", {})).json.error, /has code/);
  assert.equal((await call(server, "PUT", "/api/map/blocks/src-store", { layer: "ui" })).status, 200);
  assert.equal(read().blocks.find((block) => block.id === "src-store").layer, "ui");
  assert.equal((await call(server, "DELETE", "/api/map/dependencies", { from: "src-screens", to: "src-store" })).status, 200);
  assert.deepEqual(read().dependencies, []);
  assert.equal((await call(server, "DELETE", "/api/map/blocks/src-screens", {})).status, 200);
  assert.deepEqual(read().blocks.map((block) => block.id), ["src-store"]);
});

test("editing a project with code but no map saves the map from the code first", async (t) => {
  const root = copyFixture("shop");
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());
  assert.equal((await call(server, "POST", "/api/map/blocks", { name: "Wishlist", layer: "domain" })).status, 200);
  const model = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
  assert.equal(model.blocks.length, 7);
  assert.equal(model.layers, undefined, "the default layers stay implicit");
  assert.ok(model.dependencies.length > 0);
});
