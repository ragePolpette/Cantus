import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyFixture, shopModel } from "./helpers.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "measure-map.mjs");

function mappedShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  return root;
}

test("measure-map: times the analysis, the page data and the server's page, and leaves the project as it found it", () => {
  const root = mappedShop();
  const before = fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8");
  const run = spawnSync(process.execPath, [script, root, "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.blocks, 6);
  assert.ok(result.files > 0 && result.pageKB > 0);
  for (const key of ["analysis (cache on disk as it is)", "analysis after a map edit or a code change #3", "page data (buildViewData)"]) assert.equal(typeof result[key], "number", key);
  assert.equal(result.serverPage.length, 4);
  assert.ok(result.serverPage.every((entry) => entry.bytes > 1000));
  assert.match(run.stderr, /GET \/ on the map server/);
  assert.equal(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"), before, "the map is not touched");
});

test("measure-map --cold: analyzes with no cache, then puts the cache back", () => {
  const root = mappedShop();
  const cache = path.join(root, ".cantus/cache");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "keep.txt"), "kept");
  const run = spawnSync(process.execPath, [script, root, "--cold", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(typeof JSON.parse(run.stdout)["analysis, no cache on disk"], "number");
  assert.equal(fs.readFileSync(path.join(cache, "keep.txt"), "utf8"), "kept", "what was in the cache folder is back");
  assert.equal(fs.existsSync(`${cache}.measure-aside`), false);
});
