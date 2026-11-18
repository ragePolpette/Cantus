import assert from "node:assert/strict";
import test from "node:test";
import { analyze } from "../dist/index.js";
import { renderMap } from "../dist/mcp/server.js";
import { copyFixture } from "./helpers.mjs";

const finding = (kind, message, extra = {}) => ({ severity: "warning", kind, message, blocks: [], ...extra });

test("map: sixty files whose types need inference are one line, after the cycles and layers", () => {
  const analysis = analyze(copyFixture("shop"), { skipGit: true });
  const incomplete = Array.from({ length: 60 }, (_, index) => finding("incomplete-contract", `Contract of web/p${index}.js is incomplete: TS9007. Add explicit types.`, { files: [`web/p${index}.js`], blocks: ["src-web"] }));
  const findings = [...incomplete, finding("cycle", "Dependency cycle: a → b → a", { blocks: ["a", "b"] }), finding("layer-violation", "src-web reaches the database")];
  const text = renderMap({ analysis, model: undefined, findings });
  const section = text.slice(text.indexOf("## Open findings"));
  assert.equal(section.split("\n").filter((line) => line.startsWith("- ")).length, 3, "the cycle, the layer, one line for the contracts");
  assert.match(section, /60 public file\(s\) have incomplete contracts/);
  assert.ok(section.indexOf("Dependency cycle") < section.indexOf("incomplete contracts"));
  assert.ok(section.indexOf("src-web reaches") < section.indexOf("incomplete contracts"));
  assert.doesNotMatch(section, /Contract of web\/p0/);
});
