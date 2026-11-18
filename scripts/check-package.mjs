import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { runNpm } from "./npm-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const result = runNpm(args, root);
const files = new Set(JSON.parse(result)[0].files.map(file => file.path));
const grammars = {
  "c_sharp": "c-sharp",
  go: "go",
  java: "java",
  php: "php",
  python: "python",
  rust: "rust",
};
const required = ["package.json", "README.md", "dist/cli.js", "dist/index.js", "dist/index.d.ts", "dist/main.js", "dist/analysis/language-worker.js", "dist/analysis/csharp-worker.js", "LICENSE", "NOTICE", "licenses/IBM-Plex.LICENSE"];
const failures = [];
const samples = {
  c_sharp: "public class Example { public int Value() { return 1; } }",
  go: "package example\nfunc Value() int { return 1 }\n",
  java: "public class Example { public int value() { return 1; } }",
  php: "<?php function value(): int { return 1; }",
  python: "def value():\n    return 1\n",
  rust: "pub fn value() -> i32 { 1 }",
};
await Parser.init();
for (const [grammar, license] of Object.entries(grammars)) {
  const wasm = `grammars/tree-sitter-${grammar}.wasm`;
  required.push(wasm, `grammars/tree-sitter-${license}.LICENSE`);
  try {
    const bytes = fs.readFileSync(path.join(root, wasm));
    if (!WebAssembly.validate(bytes)) throw new Error("invalid WebAssembly");
    const parser = new Parser();
    try {
      parser.setLanguage(await Language.load(bytes));
      const tree = parser.parse(samples[grammar]);
      if (!tree) throw new Error("parser returned no tree");
      try {
        if (tree.rootNode.hasError) throw new Error("parser rejected its language sample");
      } finally { tree.delete(); }
    } finally { parser.delete(); }
  } catch (error) {
    failures.push(`Cannot use ${wasm}: ${error.message}`);
  }
}
for (const file of required) if (!files.has(file)) failures.push(`Missing from package: ${file}`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${required.length} required files in the npm pack list.`);
}
