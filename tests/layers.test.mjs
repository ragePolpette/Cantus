import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { allowedLayers, analyze, buildContextPack, buildViewData, check, inferBlocks, renderContextPrompt, modelLayers, selectableLayers, scaffold, updateMap, validateModel } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

/** The shop with its own three layers: ui on top, then features, then core. */
function customModel() {
  const layerOf = { "src-web": "ui", "src-checkout": "features", "src-orders": "core", "src-pricing": "core", "src-payments": "core", "src-db": "core" };
  const model = shopModel();
  return {
    ...model,
    layers: ["ui", "features", "core", "platform"],
    blocks: model.blocks.map((block) => ({ ...block, layer: layerOf[block.id] })),
    rules: { allow: {} },
  };
}

const violations = (analysis, model) => check(analysis, model).filter((finding) => finding.kind === "layer-violation").map((finding) => `${finding.from}->${finding.to}`);

test("a map can name its own layers; each one may use itself and the layers below, unless a rule says otherwise", () => {
  const model = customModel();
  assert.deepEqual(validateModel(model), []);
  assert.deepEqual(modelLayers(model), ["ui", "features", "core", "platform"]);
  assert.deepEqual(allowedLayers(model, "features"), ["features", "core", "platform"]);
  assert.equal(allowedLayers(model, "unassigned"), undefined);

  const root = copyFixture("shop");
  const analysis = analyze(root, { model, skipGit: true });
  assert.deepEqual(violations(analysis, model), [], "every dependency goes down or sideways");

  // Payments moves to the top: checkout (features) now uses a layer above it.
  const upward = { ...model, blocks: model.blocks.map((block) => (block.id === "src-payments" ? { ...block, layer: "ui" } : block)) };
  assert.deepEqual(violations(analyze(root, { model: upward, skipGit: true }), upward), ["src-checkout->src-payments"]);

  // An explicit rule replaces the automatic one.
  const ruled = { ...model, rules: { allow: { core: ["platform"] } } };
  assert.deepEqual(violations(analyze(root, { model: ruled, skipGit: true }), ruled), ["src-orders->src-db"]);
});

test("maps without their own layers work as before", () => {
  const model = shopModel();
  assert.deepEqual(modelLayers(model), ["interface", "application", "domain", "infrastructure"]);
  const root = copyFixture("shop");
  assert.deepEqual(violations(analyze(root, { model, skipGit: true }), model), ["src-orders->src-db", "src-web->src-db"]);
  // A default layer without a rule stays unchecked, as it always was.
  const partial = { ...model, rules: { allow: { interface: ["interface"] } } };
  assert.equal(allowedLayers(partial, "domain"), undefined);
  assert.deepEqual(violations(analyze(root, { model: partial, skipGit: true }), partial), ["src-web->src-checkout", "src-web->src-db"]);
});

test("layer mistakes in the map are reported", () => {
  const model = customModel();
  assert.deepEqual(validateModel({ ...model, layers: ["ui", "ui", "unassigned", ""] }).filter((problem) => /layer/.test(problem)).slice(0, 3), [
    'layer "ui" is listed twice',
    '"unassigned" is always there: do not list it in layers',
    "layer names must not be empty",
  ]);
  assert.match(validateModel({ ...model, layers: [] }).join("\n"), /at least one layer/);
  assert.match(validateModel({ ...model, rules: { allow: { core: ["cloud"] } } }).join("\n"), /rules\.allow\.core names unknown layer "cloud"/);
  assert.match(validateModel({ ...model, blocks: [...model.blocks, { id: "x", name: "X", layer: "domain", include: ["x"] }] }).join("\n"), /block "x" has unknown layer "domain"/);
  assert.deepEqual(validateModel({ ...model, blocks: [...model.blocks, { id: "x", name: "X", layer: "unassigned", include: ["x"] }] }), []);
});

test("the map shows a map's own layers in order, empty ones too; new blocks get unassigned", () => {
  const root = copyFixture("shop");
  const model = customModel();
  const analysis = analyze(root, { model, skipGit: true });
  assert.deepEqual(buildViewData(analysis, model, check(analysis, model)).layers, ["ui", "features", "core", "platform"]);

  const withoutDb = { ...model, blocks: model.blocks.filter((block) => block.id !== "src-db") };
  const update = updateMap(root, analyze(root, { model: withoutDb, skipGit: true }), withoutDb);
  assert.deepEqual(update.model.blocks.filter((block) => block.id === "src-db").map((block) => block.layer), ["unassigned"], "folder names hint at default layers only");
  assert.deepEqual(validateModel(update.model), []);
});

test("a design can bring its own layers", () => {
  const root = copyFixture("shop");
  fs.rmSync(path.join(root, "src"), { recursive: true });
  const design = {
    name: "notes",
    layers: ["screens", "logic"],
    blocks: [
      { name: "Screens", layer: "screens", path: "src/screens", description: "UI", contract: "export {};" },
      { name: "Logic", layer: "logic", path: "src/logic", description: "Rules", contract: "export {};" },
    ],
    dependencies: [{ from: "src/screens", to: "src/logic" }],
  };
  const result = scaffold(root, design);
  assert.deepEqual(result.model.layers, ["screens", "logic"]);
  assert.deepEqual(result.model.rules, { allow: {} });
  assert.throws(() => scaffold(copyFixture("shop"), { ...design, blocks: [{ ...design.blocks[0], layer: "nowhere" }] }), /unknown layer "nowhere"/);
});

test("host and test are layers a default map may use: they show only once a block is in them, host may use anything and nothing may use host or test", () => {
  const model = shopModel();
  assert.deepEqual(modelLayers(model), ["interface", "application", "domain", "infrastructure"]);
  assert.deepEqual(selectableLayers(model), ["host", "interface", "application", "domain", "infrastructure", "test"]);
  const root = copyFixture("shop");
  const before = violations(analyze(root, { model, skipGit: true }), model);

  const withHost = { ...model, blocks: model.blocks.map((block) => (block.id === "src-web" ? { ...block, layer: "host" } : block)) };
  assert.deepEqual(validateModel(withHost), []);
  assert.deepEqual(modelLayers(withHost), ["host", "interface", "application", "domain", "infrastructure"]);
  assert.equal(allowedLayers(withHost, "host"), undefined, "host is not checked: it may use anything");
  assert.deepEqual(violations(analyze(root, { model: withHost, skipGit: true }), withHost), before.filter((entry) => !entry.startsWith("src-web->")));

  // Db as a test block: whoever uses it from a real layer is flagged.
  const withTest = { ...model, blocks: model.blocks.map((block) => (block.id === "src-db" ? { ...block, layer: "test" } : block)) };
  assert.deepEqual(validateModel(withTest), []);
  assert.equal(modelLayers(withTest).at(-1), "test");
  assert.ok(violations(analyze(root, { model: withTest, skipGit: true }), withTest).includes("src-orders->src-db"));

  // A map with its own layers does not get them.
  assert.deepEqual(selectableLayers(customModel()), ["ui", "features", "core", "platform"]);
});

test("blocks found in folders named specs or bootstrap are guessed as test or host (tests/ folders stay out of the analysis)", () => {
  const files = ["src/orders/a.ts", "src/orders/b.ts", "src/specs/e.ts", "src/specs/f.ts", "src/bootstrap/g.ts", "src/bootstrap/h.ts", "src/web/i.ts", "src/web/j.ts"];
  const blocks = inferBlocks(fs.realpathSync.native(os.tmpdir()), files);
  const layerOf = (prefix) => blocks.find((block) => block.include.some((entry) => entry === prefix || entry.startsWith(prefix + "/")))?.layer;
  assert.equal(layerOf("src/specs"), "test");
  assert.equal(layerOf("src/bootstrap"), "host");
  assert.equal(layerOf("src/web"), "interface");
});

test("test projects get the test layer; blocks of a single file are said once, and not in a block's briefing", () => {
  const blocks = inferBlocks(fs.realpathSync.native(os.tmpdir()), ["Shop.Api/A.cs", "Shop.Api/B.cs", "Shop.Tests/AT.cs", "Shop.Tests/BT.cs", "Shop.Core/C.cs", "Shop.Core/D.cs"]);
  assert.equal(blocks.find((block) => block.include[0] === "Shop.Tests").layer, "test");
  assert.equal(blocks.find((block) => block.include[0] === "Shop.Api").layer, "interface");

  const root = copyFixture("shop");
  const model = shopModel();
  const analysis = analyze(root, { model, skipGit: true });
  const findings = check(analysis, model);
  const tiny = findings.filter((finding) => finding.kind === "tiny-blocks");
  assert.equal(tiny.length, 1);
  assert.deepEqual(tiny[0].blocks.sort(), ["src-db", "src-orders", "src-payments", "src-pricing", "src-web"]);
  assert.doesNotMatch(renderContextPrompt(buildContextPack(analysis, "src-db", model, findings), { root, inlineSources: false }), /hold a single file/);
  const described = { ...model, blocks: model.blocks.map((block) => (block.id === "src-db" ? { ...block, description: "The database client." } : block)) };
  assert.ok(!check(analyze(root, { model: described, skipGit: true }), described).find((finding) => finding.kind === "tiny-blocks").blocks.includes("src-db"));
});
