import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { analyze } from "cantus";

const samples = [
    ["javascript", "src/example.js", "export function value() { return 1; }"],
    ["typescript", "src/example.ts", "export function value(): number { return 1; }"],
    ["vue", "src/Example.vue", '<script>export function value() { return 1; } export default { name: "Example" };</script><template><div>Example</div></template>'],
    ["python", "src/example.py", "def value():\n    return 1\n"],
    ["go", "src/example.go", "package example\nfunc Value() int { return 1 }\n"],
    ["java", "src/Example.java", "public class Example { public int value() { return 1; } }"],
    ["csharp", "src/Example.cs", "public class Example { public int Value() { return 1; } }"],
    ["rust", "src/lib.rs", "pub fn value() -> i32 { 1 }"],
    ["php", "src/example.php", "<?php function value(): int { return 1; }"],
  ];

let failed = false;
for (const [language, file, source] of samples) {
  try {
    const project = path.resolve("projects", language);
    fs.mkdirSync(path.join(project, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), source);
    if (language === "rust") fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2021"\n');
    const result = analyze(project, { skipGit: true, cache: false });
    const errors = result.diagnostics.filter(d => d.level === "error");
    assert.deepEqual(errors, [], language + ": analysis errors");
    assert.ok(result.catalog.length > 0, language + ": no public API found");
    console.log(language + ": public API found");
  } catch (error) {
    failed = true;
    console.error(language + ": " + error.message);
  }
}
if (failed) process.exitCode = 1;
