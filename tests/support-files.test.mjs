import assert from "node:assert/strict";
import test from "node:test";
import { isSupportFile } from "../dist/index.js";

test("a support file is a test or a document; source, manifests, config, dot-files and generated folders are not", () => {
  for (const file of ["test/a.mjs", "tests/unit/orders.spec.ts", "src/x/__tests__/y.ts", "e2e/login.ts", "fixtures/data.json", "src/a.test.ts", "tests/test_orders.py", "pkg/orders_test.go", "src/FooTest.java", "src/FooTests.cs", "CHANGELOG.md", "docs/guide.md", "README.md", "notes.txt", "docs/api.rst"]) {
    assert.equal(isSupportFile(file), true, file);
  }
  for (const file of ["src/orders/index.ts", "src/a.py", "lib/x.rs", "main.go", "app/Api.cs", "page.html", "types/global.d.ts", "test/types.d.ts", ".env", ".github/workflows/ci.yml", ".gitignore", "src/.hidden/a.md", "node_modules/x/readme.md", "dist/notes.txt", "package.json", "pyproject.toml", "vite.config.ts", "LICENSE", "Makefile", "styles/site.css"]) {
    assert.equal(isSupportFile(file), false, file);
  }
});
