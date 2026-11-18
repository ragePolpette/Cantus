import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, findCallers } from "../dist/index.js";

function project(files) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-go-pkg-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/shop\n\ngo 1.22\n");
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const sites = (analysis) => analysis.callSites.filter((site) => site.via === "type").map((site) => `${site.file}:${site.line} ${site.symbol} → ${site.targetFile} (${site.match})`).sort();

test("Go: files of the same package use each other's exported names without an import", () => {
  const root = project({
    "shop/order.go": "package shop\n\ntype Order struct{ Total int }\n\nfunc NewOrder() *Order { return &Order{} }\n\nconst Limit = 10\n",
    "shop/pricing.go": "package shop\n\nfunc Price(o *Order) int {\n\treturn o.Total * Limit\n}\n\nfunc Make() *Order {\n\treturn NewOrder()\n}\n",
  });
  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(sites(analysis), [
    "shop/pricing.go:8 NewOrder → shop/order.go (certain)",
    "shop/pricing.go:3 Order → shop/order.go (certain)",
    "shop/pricing.go:4 Limit → shop/order.go (certain)",
    "shop/pricing.go:7 Order → shop/order.go (certain)",
  ].sort());
  const answer = findCallers(analysis, { symbol: "NewOrder" });
  assert.deepEqual(answer.sites.map((site) => `${site.file}:${site.line}`), ["shop/pricing.go:8"], "callers sees it, the blocks being inferred from folders");
});

test("Go: a name declared in the file itself, a local of that name, a lower-case name and a struct field are not uses", () => {
  const root = project({
    "shop/order.go": "package shop\n\ntype Order struct{ Total int }\n\nfunc Total() int { return 0 }\n\nfunc helper() int { return 1 }\n\nfunc Name() string { return \"\" }\n",
    "shop/local.go": "package shop\n\nfunc Own() int {\n\tTotal := 3\n\treturn Total\n}\n\nfunc Fields() Order {\n\treturn Order{Total: 4}\n}\n\nfunc Uses() int { return helper() }\n",
    "shop/self.go": "package shop\n\nfunc Name() string { return \"x\" }\n\nfunc Call() string { return Name() }\n",
  });
  const found = sites(analyze(root, { skipGit: true }));
  assert.ok(!found.some((entry) => entry.includes(" Total →")), "a local named Total hides the package-level one, and Total: in a literal is a field");
  assert.ok(!found.some((entry) => entry.includes(" helper →")), "lower-case names are not exports");
  assert.ok(!found.some((entry) => entry.startsWith("shop/self.go") && entry.includes(" Name →")), "a name the file declares itself");
  assert.ok(found.some((entry) => entry.startsWith("shop/local.go:8") && entry.includes(" Order → shop/order.go")), "but a type used elsewhere in that file is");
});

test("Go: another package in the same folder (name_test), and another folder, are not the same package", () => {
  const root = project({
    "shop/order.go": "package shop\n\nfunc NewOrder() int { return 1 }\n",
    "shop/order_ext.go": "package shop_test\n\nfunc Check() int { return NewOrder() }\n",
    "other/other.go": "package other\n\nfunc Run() int { return NewOrder() }\n",
  });
  assert.deepEqual(sites(analyze(root, { skipGit: true })), []);
});

test("Go: a file built only for some systems does not win over the plain file, and its own uses still count", () => {
  const root = project({
    "tui/tui.go": "package tui\n\nfunc Size() int { return 1 }\n\nfunc Clear() {}\n",
    "tui/size_windows.go": "package tui\n\nfunc Size() int { return 2 }\n\nfunc Resize() int {\n\tClear()\n\treturn Size()\n}\n",
    "tui/use.go": "package tui\n\nfunc Show() int { return Size() }\n",
    "tui/tcell.go": "//go:build tcell\n\npackage tui\n\nfunc Tcell() int { return 3 }\n",
    "tui/use_tcell.go": "package tui\n\nfunc Draw() int { return Tcell() }\n",
  });
  const found = sites(analyze(root, { skipGit: true }));
  assert.ok(found.includes("tui/use.go:3 Size → tui/tui.go (certain)"), "the file with no constraint wins");
  assert.ok(!found.some((entry) => entry.startsWith("tui/use.go") && entry.includes("size_windows")), "…and the variant is not a second target");
  assert.ok(found.includes("tui/size_windows.go:6 Clear → tui/tui.go (certain)"), "a file for one system still uses the plain file's names");
  assert.ok(found.includes("tui/use_tcell.go:3 Tcell → tui/tcell.go (likely)"), "a name only a tagged file declares is likely, not certain");
});
