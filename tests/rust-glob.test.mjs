import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, findCallers } from "../dist/index.js";

function project(files) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-rs-glob-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const sites = (analysis, via = "import") => analysis.callSites.filter((site) => site.via === via).map((site) => `${site.file}:${site.line} ${site.symbol} → ${site.targetFile}`).sort();

/** The layout of just: a crate with a library and a binary, a root that imports what the modules share, and modules that glob it. */
const files = {
  "Cargo.toml": '[package]\nname = "shop"\nversion = "0.1.0"\n\n[lib]\ndoctest = false\n\n[[bin]]\npath = "src/main.rs"\nname = "shop"\n',
  "src/main.rs": "fn main() { shop::run(); }\n",
  "src/lib.rs": "mod order;\nmod pricing;\nmod report;\n\npub(crate) use {crate::order::Order, crate::pricing::price, std::fmt::Display};\n\npub fn run() {}\n\npub(crate) struct Settings;\n",
  "src/order.rs": "use super::*;\n\npub(crate) struct Order {\n  pub(crate) total: u32,\n}\n",
  "src/pricing.rs": "use super::*;\n\npub(crate) fn price(order: &Order, settings: &Settings) -> u32 {\n  order.total\n}\n",
  "src/report.rs": "use super::*;\n\nstruct Line<'run> {\n  order: &'run Order,\n}\n\nfn show(order: Order) -> u32 {\n  let price = 3;\n  match order {\n    Order { total } => price + total,\n  }\n}\n\nfn cost(order: &Order, settings: &Settings) -> u32 {\n  crate::price(order, settings)\n}\n",
};

test("Rust: the crate's root is lib.rs when [lib] has no path and a [[bin]] has one", () => {
  const analysis = analyze(project(files), { skipGit: true });
  assert.ok(analysis.fileImports.some((edge) => edge.from === "src/pricing.rs" && edge.to === "src/order.rs"), "a module reaches a sibling through the root's imports");
});

test("Rust: `use super::*` brings in the parent's own items and what it imports, each linked to its definition", () => {
  const found = sites(analyze(project(files), { skipGit: true }));
  assert.ok(found.includes("src/pricing.rs:3 Order → src/order.rs"), "Order comes through lib.rs's `use crate::order::Order`");
  assert.ok(found.includes("src/pricing.rs:3 Settings → src/lib.rs"), "Settings is declared in the parent itself");
  assert.ok(found.includes("src/report.rs:7 Order → src/order.rs"));
  assert.ok(found.includes("src/report.rs:10 Order → src/order.rs"), "`Order { total }` in a pattern is a use of the type, not a binding");
});

test("Rust: lifetimes and names the file binds or imports itself are not uses of what the glob brought", () => {
  const found = sites(analyze(project(files), { skipGit: true }));
  assert.ok(!found.some((entry) => entry.startsWith("src/report.rs") && entry.includes(" run →")), "'run is a lifetime");
  assert.ok(!found.some((entry) => entry.startsWith("src/report.rs:9") && entry.includes(" price")), "`let price` binds a local");
  const own = project({ ...files, "src/report.rs": "use super::*;\nuse other::Order;\n\nfn show(order: Order) {}\n" });
  assert.ok(!sites(analyze(own, { skipGit: true })).some((entry) => entry.startsWith("src/report.rs") && entry.includes(" Order →")), "an explicit import wins over the glob");
});

test("Rust: callers lists the uses that come through a glob", () => {
  const analysis = analyze(project(files), { skipGit: true });
  const answer = findCallers(analysis, { symbol: "Order" });
  assert.deepEqual([...new Set(answer.sites.map((site) => site.file))].sort(), ["src/pricing.rs", "src/report.rs"]);
});

test("Rust: a glob of a module that is not an ancestor sees only what the module declares pub", () => {
  const found = sites(analyze(project({
    ...files,
    "src/lib.rs": "mod order;\nmod util;\nmod user;\n",
    "src/order.rs": "pub(crate) struct Order;\nstruct Secret;\n",
    "src/util.rs": "",
    "src/user.rs": "use crate::order::*;\n\nfn f(a: Order, b: Secret) {}\n",
    "src/pricing.rs": "",
    "src/report.rs": "",
  }), { skipGit: true }));
  assert.ok(found.includes("src/user.rs:3 Order → src/order.rs"));
  assert.ok(!found.some((entry) => entry.includes(" Secret →")), "a private item is not visible through a glob from outside");
});
