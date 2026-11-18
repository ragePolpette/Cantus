import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";

// The names a folder gets from its manifest (package.json, go.mod, pyproject.toml, Cargo.toml, a lone .csproj), read from the folder's listing.
test("a folder is named by the manifest it holds, and the ones it lacks are not looked for", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-packages-"));
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  put("package.json", '{"name":"root-name"}');
  put("a/package.json", '{"name":"pkg-a"}');
  put("b/go.mod", "module github.com/x/gomod/v2\n");
  put("c/pyproject.toml", '[project]\nname = "pyproj"\n');
  put("d/Cargo.toml", '[package]\nname = "rustcrate"\n');
  put("e/Orders.Api.csproj", "<Project/>");
  put("f/package.json", "{ bad");
  put("g/package.json", '{"version":"1"}');
  put("g/sub/package.json", '{"name":"nested"}');
  put("h/One.csproj", "<Project/>");
  put("h/Two.csproj", "<Project/>");
  put("h/deep/package.json", '{"name":"deepname"}');
  put("i/src/index.ts", "export const x = 1;\n");
  for (const dir of ["a", "b", "c", "d", "e", "f", "g/sub", "h/deep"]) put(`${dir}/src/index.ts`, "export const x = 1;\n");

  const analysis = analyze(root, { skipGit: true, cache: false });
  assert.deepEqual(
    analysis.blocks.map((info) => [info.block.id, info.block.name]),
    [["a", "Pkg A"], ["b", "Gomod"], ["c", "Pyproj"], ["d", "Rustcrate"], ["e", "Orders Api"], ["f", "Root Name · F"], ["g-sub", "Nested"], ["h-deep", "Deepname"], ["i", "Root Name · I"]],
  );
  const notes = analysis.diagnostics.filter((diagnostic) => diagnostic.stage === "packages").map((diagnostic) => [diagnostic.level, diagnostic.file]);
  assert.deepEqual(notes, [["warning", "f/package.json"], ["info", "g/package.json"]]);
});
