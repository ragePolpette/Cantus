import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectState, applyDraft, draftPrompt, parseDraft, requestDraft, startMapServer } from "../dist/index.js";
import { shopModel } from "./helpers.mjs";

const DRAFT = {
  layers: ["ui", "core"],
  blocks: [
    { name: "Screens", layer: "ui", folder: "src/screens", description: "The pages." },
    { name: "Notes", layer: "core", folder: "./src/notes/", description: "Notes with tags." },
    { name: "Sync", layer: "cloud", folder: "src/sync", description: "Sync to a server." },
  ],
  dependencies: [{ from: "src/screens", to: "src/notes" }, { from: "src/screens", to: "src/nowhere" }, { from: "src/notes", to: "src/notes" }],
};

test("a draft is read from the agent's answer", () => {
  const answer = "Here is a first idea:\n```json\n{\"blocks\": []}\n```\nAnd the final one:\n```json\n" + JSON.stringify(DRAFT) + "\n```";
  assert.deepEqual(parseDraft(answer), DRAFT, "the last JSON block wins");
  assert.deepEqual(parseDraft(JSON.stringify(DRAFT)), DRAFT, "bare JSON works too");
  assert.throws(() => parseDraft("I would split it into three parts."), /did not answer with a draft/);
  assert.throws(() => parseDraft('```json\n{"blocks": [{"name": "x"}]}\n```'), /not in the expected shape: blocks\.0\.layer/);
});

test("a draft fills an empty map, or adds to a map without touching it", () => {
  const fresh = applyDraft(undefined, DRAFT);
  assert.deepEqual(fresh.model.layers, ["ui", "core"]);
  assert.deepEqual(fresh.model.rules, { allow: {} }, "an empty map takes the draft's layers with automatic rules");
  assert.deepEqual(fresh.model.blocks.map((block) => `${block.id}:${block.layer}:${block.include[0]}`), ["src-screens:ui:src/screens", "src-notes:core:src/notes", "src-sync:unassigned:src/sync"]);
  assert.deepEqual(fresh.addedDependencies, [{ from: "src-screens", to: "src-notes" }], "arrows to unknown folders or to the block itself are skipped");
  assert.deepEqual(fresh.addedLayers, ["ui", "core"]);

  const shop = shopModel();
  shop.blocks[0].description = "Mine.";
  const extended = applyDraft(shop, {
    layers: ["interface", "edge"],
    blocks: [{ name: "Web again", layer: "interface", folder: "src/web", description: "Theirs." }, { name: "Wishlist", layer: "domain", folder: "src/wishlist", description: "Saved items." }],
    dependencies: [{ from: "src/checkout", to: "src/wishlist" }, { from: "src/web", to: "src/checkout" }],
  });
  assert.deepEqual(extended.model.layers, ["interface", "application", "domain", "infrastructure", "edge"], "new layers go below");
  assert.deepEqual(extended.model.rules, shop.rules, "existing rules are kept");
  assert.equal(extended.model.blocks[0].description, "Mine.", "blocks already on the map are not touched");
  assert.deepEqual(extended.addedBlocks, ["src-wishlist"]);
  assert.deepEqual(extended.addedDependencies, [{ from: "src-checkout", to: "src-wishlist" }], "arrows already on the map are not added twice");
  assert.equal(applyDraft(shop, { blocks: [], dependencies: [] }).model.layers, undefined, "without new layers the defaults stay implicit");
});

/** A stand-in for Claude Code that tries a write and a read, then answers with `answer`. */
function draftingRunner(answer, seen = {}) {
  return (request) => ({
    async *[Symbol.asyncIterator]() {
      seen.prompt = request.prompt;
      seen.write = await request.canUseTool("Write", { file_path: "x" }, request.abort.signal);
      seen.read = await request.canUseTool("Read", { file_path: "x" }, request.abort.signal);
      yield { type: "text", text: "Looking at the project." };
      yield { type: "result", ok: true, text: answer };
    },
  });
}

test("the drafting agent reads the project, changes nothing, and gets the map as it is", async () => {
  const seen = {};
  const draft = await requestDraft(draftingRunner("```json\n" + JSON.stringify(DRAFT) + "\n```", seen), { cwd: fs.realpathSync.native(os.tmpdir()), description: "A notes app with sync.", map: shopModel() });
  assert.deepEqual(draft, DRAFT);
  assert.equal(seen.read.allow, true);
  assert.equal(seen.write.allow, false);
  assert.match(seen.prompt, /A notes app with sync\./);
  assert.match(seen.prompt, /- Orders \(domain\), folder src\/orders/);
  assert.match(draftPrompt("x", undefined), /No blocks yet/);
  const failing = () => ({ async *[Symbol.asyncIterator]() { yield { type: "result", ok: false, text: "Budget exceeded." }; } });
  await assert.rejects(requestDraft(failing, { cwd: fs.realpathSync.native(os.tmpdir()), description: "x" }), /Budget exceeded/);
});

function call(server, method, pathname, body) {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "x-cantus-token": server.token, ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("the live map previews a draft, and saves it only when kept", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-draft-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const server = await startMapServer(new ProjectState(root), { port: 0, runner: draftingRunner("```json\n" + JSON.stringify(DRAFT) + "\n```") });
  t.after(() => server.close());
  const modelFile = path.join(root, ".cantus/model.json");

  assert.equal((await call(server, "POST", "/api/map/draft", { description: " " })).status, 400);
  const preview = await call(server, "POST", "/api/map/draft", { description: "A notes app." });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.addedBlocks, ["src-screens", "src-notes", "src-sync"]);
  assert.deepEqual(preview.json.model.layers, ["ui", "core"]);
  assert.ok(!fs.existsSync(modelFile), "a preview saves nothing");

  assert.equal((await call(server, "POST", "/api/map/draft/apply", { draft: { blocks: "nope" } })).status, 400);
  assert.equal((await call(server, "POST", "/api/map/draft/apply", { draft: preview.json.draft })).status, 200);
  const saved = JSON.parse(fs.readFileSync(modelFile, "utf8"));
  assert.deepEqual(saved.blocks.map((block) => block.id), ["src-screens", "src-notes", "src-sync"]);
  assert.deepEqual(saved.dependencies, [{ from: "src-screens", to: "src-notes" }]);
});
