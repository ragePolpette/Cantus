import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";

function project(files) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-cs-using-"));
  fs.writeFileSync(path.join(root, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const sites = (analysis) => analysis.callSites.filter((site) => site.via === "type").map((site) => `${site.file}:${site.line} ${site.symbol} → ${site.targetFile} (${site.match})`).sort();

const RESULT = "namespace Shop.Results;\n\npublic class ValidationResult { }\n";

test("C#: a using inside a namespace is looked up from that namespace outwards (file-scoped and block namespaces)", () => {
  const root = project({
    "Results/ValidationResult.cs": RESULT,
    "Tests/FileScoped.cs": "namespace Shop.Tests;\n\nusing Results;\n\npublic class A\n{\n    ValidationResult Run() => null;\n}\n",
    "Tests/Block.cs": "namespace Shop.Tests\n{\n    using Results;\n\n    public class B\n    {\n        ValidationResult Run() => null;\n    }\n}\n",
    "Tests/Nested.cs": "namespace Shop\n{\n    namespace Tests\n    {\n        using Results;\n\n        public class C\n        {\n            ValidationResult Run() => null;\n        }\n    }\n}\n",
  });
  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(sites(analysis), [
    "Tests/Block.cs:7 ValidationResult → Results/ValidationResult.cs (likely)",
    "Tests/FileScoped.cs:7 ValidationResult → Results/ValidationResult.cs (likely)",
    "Tests/Nested.cs:9 ValidationResult → Results/ValidationResult.cs (likely)",
  ]);
});

test("C#: a using before the namespace stays absolute, and so does one with no match inside it", () => {
  const root = project({
    "Results/ValidationResult.cs": RESULT,
    // `using Results;` outside any namespace names a root namespace `Results`, which does not exist: no link.
    "Tests/Outside.cs": "using Results;\n\nnamespace Shop.Tests;\n\npublic class A\n{\n    ValidationResult Run() => null;\n}\n",
    // Absolute name inside a namespace: no `Shop.Tests.Shop.Results`, so it is read as written.
    "Tests/Absolute.cs": "namespace Shop.Tests;\n\nusing Shop.Results;\n\npublic class B\n{\n    ValidationResult Run() => null;\n}\n",
  });
  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(sites(analysis), ["Tests/Absolute.cs:7 ValidationResult → Results/ValidationResult.cs (likely)"]);
});
