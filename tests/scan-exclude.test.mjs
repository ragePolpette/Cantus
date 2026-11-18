import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SCANNED_EXTENSIONS, createSourceScanner, isExcluded, matchesGlob, scanSourceFiles } from "../dist/analysis/analyze.js";
import { copyFixture } from "./helpers.mjs";

/** The glob match as it was before patterns were read once: the reference the new one must agree with. */
function reference(relative, pattern) {
  const segments = relative.split("/");
  const target = pattern.includes("/") ? segments : [segments[segments.length - 1]];
  const parts = pattern.split("/");
  const segmentMatches = (part, segment) => {
    if (part === segment) return true;
    const regex = new RegExp(`^${part.split("*").map((piece) => piece.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join(".*")}$`);
    return regex.test(segment);
  };
  const matches = (parts, target) => {
    if (parts.length === 0) return target.length === 0;
    if (parts[0] === "**") {
      for (let skip = 0; skip <= target.length; skip++) if (matches(parts.slice(1), target.slice(skip))) return true;
      return false;
    }
    return target.length > 0 && segmentMatches(parts[0], target[0]) && matches(parts.slice(1), target.slice(1));
  };
  return matches(parts, target);
}

const patterns = ["**/*.min.js", "assets/plugins/**", "Scripts/jquery*", "Scripts/**/*.intellisense.js", "**/*.designer.cs", "web/**/old*", "*.map", "a/*/c", "**", "**/", "src/**/test/**", "x.y+z/(a)/*", "lib/[v]*.js", "*", "a//b", "docs/", "**/vendor/**"];
const paths = ["a.min.js", "web/a/b.min.js", "assets/plugins/x/y.js", "assets/plugins", "assets/other.js", "Scripts/jquery-1.js", "Scripts/jquery", "Scripts/a/b/c.intellisense.js", "Scripts/c.intellisense.js", "m/n/Form1.designer.cs", "web/x/y/old-page.aspx", "web/old", "web/x/old/y.js", "bundle.js.map", "a/b/c", "a/b/c/d", "a/c", "src/test", "src/a/test/b/c.ts", "src/a/b/c.ts", "x.y+z/(a)/q", "x.y+z/(a)", "lib/[v]1.js", "lib/v1.js", "a/b", "docs", "docs/a.md", "x/vendor/y/z.js", "vendor", "", "plain"];

test("exclude patterns: the compiled match agrees with the plain one for every pattern and path tried", () => {
  for (const pattern of patterns) {
    for (const relative of paths) {
      assert.equal(matchesGlob(relative, pattern), reference(relative, pattern), `${pattern} on ${JSON.stringify(relative)}`);
    }
  }
});

test("a scan leaves the same files out as asking about each entry would, and does not look at files of other kinds", () => {
  const root = copyFixture("shop");
  const exclude = ["**/*.test.ts", "src/pricing/**", "docs/**", "Scripts/jquery*"];
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(root, "assets", `image${i}.png`), "x");
  fs.writeFileSync(path.join(root, "src/orders/index.test.ts"), "export {};\n");
  const found = scanSourceFiles(root, exclude);
  assert.ok(found.length > 0);
  assert.ok(found.every((file) => !isExcluded(file, path.basename(file), exclude)), "no file the patterns name is listed");
  assert.ok(!found.some((file) => file.startsWith("src/pricing/") || file.endsWith(".test.ts") || file.startsWith("assets/")));
  const everything = scanSourceFiles(root, []);
  for (const file of everything) assert.equal(found.includes(file), !isExcluded(file, path.basename(file), exclude), file);
});

test("one walk answers every scan of the analysis the way a walk of its own would", () => {
  const root = copyFixture("shop");
  const write = (file, text = "x") => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  for (const file of ["bin/App.cs", "obj/x/Gen.cs", "web/bin/Old.cs", "web/Page.aspx", "web/bin/page.aspx", "svc/S.asmx", "obj/S.asmx", "A.csproj", "obj/B.csproj", "lib/m.py", "target/n.py", "venv/lib/o.py", "pkg/p.go", "pkg/vendor/q.go", "docs/readme.md", "src/legacy/old.test.js", "src/legacy/app.min.js", "Global.asax", "bin/Global.asax"]) write(file);
  const exclude = ["**/*.min.js", "docs/**", "src/legacy"];
  const asked = [
    [SCANNED_EXTENSIONS.slice(0, 12), []],
    [[".cs"], ["bin", "obj"]],
    [[".py", ".go", ".java", ".rs"], ["target", "venv", "vendor"]],
    [[".aspx", ".asax", ".asmx", ".csproj"], []],
    [[".asmx", ".svc", ".ashx"], ["bin", "obj"]],
    [[".asax"], ["bin", "obj"]],
    [[".csproj", ".fsproj", ".vbproj"], ["bin", "obj"]],
    [[".js", ".ts"], ["src/legacy/*", "web"]],
  ];
  for (const include of [undefined, ["src", "web", "svc", "lib", "pkg", "bin", "obj", "A.csproj", "Global.asax"]]) {
    const scan = createSourceScanner(root, exclude, () => {}, include);
    for (const [extensions, extra] of asked) {
      assert.deepEqual(scan(extensions, extra), scanSourceFiles(root, [...exclude, ...extra], () => {}, extensions, include), `${extensions} without ${extra} (include ${include})`);
    }
  }
});

test("the first question of a scanner reports what the walk meets, like the scan it replaces", () => {
  const root = copyFixture("shop");
  if (process.platform !== "win32") fs.symlinkSync(path.join(root, "src"), path.join(root, "linked"), "dir");
  const reports = [];
  const scan = createSourceScanner(root, [], (diagnostic) => reports.push(diagnostic));
  scan([".ts"]);
  scan([".ts"], ["bin"]);
  const direct = [];
  scanSourceFiles(root, [], (diagnostic) => direct.push(diagnostic));
  assert.deepEqual(reports, direct);
});
