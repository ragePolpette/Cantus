import assert from "node:assert/strict";
import test from "node:test";
import { blockForFile, blockResolver } from "../dist/model/index.js";

// Small deterministic generator so a failure can be replayed.
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test("blockResolver answers like blockForFile, ties and whole-project prefixes included", () => {
  const next = random(42);
  const pick = (items) => items[Math.floor(next() * items.length)];
  const names = ["src", "app", "lib", "api", "ui", "core"];
  const folder = () => Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(names)).join("/");
  for (let round = 0; round < 200; round++) {
    const blocks = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, index) => ({
      id: `b${index}`,
      include: Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick([folder(), `${folder()}/`, ".", "", folder()])),
    }));
    const resolve = blockResolver(blocks);
    for (let i = 0; i < 40; i++) {
      const file = `${folder()}/${pick(["a.ts", "b.cs", "deep/c.go"])}`;
      assert.equal(resolve(file)?.id, blockForFile(blocks, file)?.id, `${file} in ${JSON.stringify(blocks)}`);
    }
  }
});
