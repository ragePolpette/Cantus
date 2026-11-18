import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { analyze, check, normalizeInclude } from "../dist/index.js";
import { isIncluded, mayHoldIncluded } from "../dist/analysis/analyze.js";
import { updateMap } from "../dist/map/update.js";
import { ProjectState } from "../dist/state/state.js";
import { validateModel } from "../dist/model/index.js";

/** A repository whose root holds the project (`webroot`), its libraries and legacy folders the map should not see. */
function repo({ git = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-include-"));
  const write = (file, text = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"repo"}');
  write("webroot/app/main.js", 'import { sharedPrice } from "../../shared/util.js";\nimport { help } from "./helper.js";\nexport const run = () => sharedPrice(help());\n');
  write("webroot/app/helper.js", "export const help = () => 1;\n");
  write("webroot/pages/index.html", '<html><body><script src="../app/main.js"></script><script src="../../shared/old.js"></script></body></html>\n');
  write("webroot/api/Api.csproj", '<Project><ItemGroup><ProjectReference Include="..\\..\\libraries\\Core\\Core.csproj" /><ProjectReference Include="..\\..\\libraries\\Extra\\Extra.csproj" /></ItemGroup></Project>');
  write("webroot/api/Orders.cs", "using Core;\nnamespace Api { public class Orders { public Money Total() { return null; } } }\n");
  write("webroot/bin/Generated.cs", "namespace Api { public class Generated { } }\n");
  write("libraries/Core/Core.csproj", "<Project></Project>");
  write("libraries/Core/Money.cs", "namespace Core { public class Money { } }\n");
  write("libraries/Extra/Extra.csproj", "<Project></Project>");
  write("libraries/Extra/Extras.cs", "namespace Extra { public class Extras { } }\n");
  write("shared/util.js", "export function sharedPrice(amount) { return amount * 2; }\n");
  write("legacy/old.js", "export const old = 1;\n");
  write("legacy/page.asp", "<% Response.Write 1 %>\n");
  write("Test2/check.js", "export const check = 1;\n");
  write("scripts/deploy.ps1");
  write("shared/sync.ps1");
  if (git) {
    const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    run("add", "-A", "-f");
    run("commit", "-q", "-m", "init");
  }
  return root;
}

const model = (analysis = {}, extra = {}) => ({
  version: 1,
  name: "repo",
  blocks: [
    { id: "app", name: "App", layer: "interface", include: ["webroot/app"] },
    { id: "pages", name: "Pages", layer: "interface", include: ["webroot/pages"] },
    { id: "api", name: "Api", layer: "application", include: ["webroot/api"] },
    { id: "core", name: "Core", layer: "domain", include: ["libraries/Core"] },
    { id: "legacy", name: "Legacy", layer: "infrastructure", include: ["legacy"] },
  ],
  dependencies: [],
  analysis,
  ...extra,
});

const filesOf = (analysis) => analysis.blocks.flatMap((info) => info.files).sort();
const run = (root, analysis, options = {}) => analyze(root, { skipGit: true, cache: false, model: model(analysis), ...options });

test("without include, with an empty list or with \".\", the analysis is the same", () => {
  const root = repo();
  const base = filesOf(run(root));
  assert.ok(base.includes("legacy/old.js") && base.includes("webroot/app/main.js") && base.includes("libraries/Extra/Extras.cs") === false, "Extra has no block, so it is in none");
  assert.deepEqual(filesOf(run(root, { include: [] })), base);
  assert.deepEqual(filesOf(run(root, { include: ["."] })), base);
  assert.deepEqual(filesOf(run(root, { include: ["./"] })), base);
  assert.equal(normalizeInclude(undefined), undefined);
  assert.equal(normalizeInclude([]), undefined);
});

test("only the included paths are analyzed; a folder above an included one is walked to reach it", () => {
  const root = repo();
  const analysis = run(root, { include: ["webroot", "libraries/Core"] });
  assert.deepEqual(filesOf(analysis), ["libraries/Core/Money.cs", "webroot/api/Orders.cs", "webroot/app/helper.js", "webroot/app/main.js"]);
  assert.deepEqual(analysis.blocks.find((info) => info.block.id === "legacy").files, []);
  assert.ok(analysis.pages.every((page) => page.file.startsWith("webroot/")));
  assert.deepEqual(filesOf(run(root, { include: ["libraries/Core"] })), ["libraries/Core/Money.cs"]);
});

test("a plain entry is a prefix from the root, not a name looked for at any depth", () => {
  const root = repo();
  fs.mkdirSync(path.join(root, "legacy/webroot"), { recursive: true });
  fs.writeFileSync(path.join(root, "legacy/webroot/deep.js"), "export const deep = 1;\n");
  const files = filesOf(run(root, { include: ["webroot"] }));
  assert.ok(files.every((file) => file.startsWith("webroot/")), files.join(", "));
  assert.ok(!files.includes("legacy/webroot/deep.js"));
  assert.ok(isIncluded("webroot/a.js", ["webroot"]));
  assert.ok(!isIncluded("webrootX/a.js", ["webroot"]), "a prefix of folders, not of letters");
});

test("globs and single files work as in exclude: a glob matches a file or a folder above it", () => {
  const root = repo();
  assert.deepEqual(filesOf(run(root, { include: ["libraries/*"] })), ["libraries/Core/Money.cs"], "Extra has no block");
  const withExtra = run(root, { include: ["libraries/*"] }, { model: { ...model({ include: ["libraries/*"] }), blocks: [...model().blocks, { id: "extra", name: "Extra", layer: "domain", include: ["libraries/Extra"] }] } });
  assert.deepEqual(filesOf(withExtra), ["libraries/Core/Money.cs", "libraries/Extra/Extras.cs"]);
  assert.deepEqual(filesOf(run(root, { include: ["webroot/app/main.js"] })), ["webroot/app/main.js"]);
  assert.deepEqual(filesOf(run(root, { include: ["**/helper.js"] })), ["webroot/app/helper.js"]);
  assert.ok(mayHoldIncluded("libraries", ["libraries/*/src/**"]));
  assert.ok(!mayHoldIncluded("legacy", ["libraries/*/src/**"]));
  assert.ok(mayHoldIncluded("anything", ["**/*.cs"]));
});

test("entries are cleaned up: ./a/, a\\b, repeats", () => {
  const root = repo();
  assert.deepEqual(normalizeInclude(["./webroot/", "webroot", "libraries\\Core"]), ["webroot", "libraries/Core"]);
  assert.deepEqual(filesOf(run(root, { include: ["./libraries/Core/"] })), ["libraries/Core/Money.cs"]);
});

test("include and exclude on the same path: exclude wins, whichever is longer; the defaults stay out", () => {
  const root = repo();
  const a = filesOf(run(root, { include: ["webroot"], exclude: ["webroot/pages", "webroot/api"] }));
  assert.deepEqual(a, ["webroot/app/helper.js", "webroot/app/main.js"]);
  assert.deepEqual(filesOf(run(root, { include: ["webroot/app"], exclude: ["webroot"] })), []);
  assert.ok(!filesOf(run(root, { include: ["webroot"] })).includes("webroot/bin/Generated.cs"), "bin/ is a default exclusion");
  assert.ok(!filesOf(run(root, { include: ["webroot/bin"] })).includes("webroot/bin/Generated.cs"), "include does not bring a default back");
});

test("an entry that matches nothing is a warning, not an error; with none matching there is nothing to analyze", () => {
  const root = repo();
  const analysis = run(root, { include: ["webroot", "webroot2", "libraries/Nope"] });
  const warnings = analysis.diagnostics.filter((d) => d.level === "warning" && /analysis\.include/.test(d.message)).map((d) => d.message);
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0] + warnings[1], /"webroot2"/);
  assert.match(warnings[0] + warnings[1], /"libraries\/Nope"/);
  assert.ok(filesOf(analysis).includes("webroot/app/main.js"));

  const none = run(root, { include: ["nowhere"] });
  assert.deepEqual(filesOf(none), []);
  assert.ok(none.diagnostics.some((d) => /no source files found/.test(d.message)));
});

test("an entry that leaves the root is ignored with a warning, and does not widen the analysis", () => {
  const root = repo();
  const analysis = run(root, { include: ["../outside", "webroot/app"] });
  assert.deepEqual(filesOf(analysis), ["webroot/app/helper.js", "webroot/app/main.js"]);
  assert.ok(analysis.diagnostics.some((d) => /leaves the map's root/.test(d.message)));
  const only = run(root, { include: ["../outside"] });
  assert.deepEqual(filesOf(only), [], "no valid entry left: nothing included, not everything");
});

test("what an included path points to in a path left out is an external folder, named from the root", () => {
  const root = repo();
  const analysis = run(root, { include: ["webroot", "libraries/Core"] });
  const byFolder = Object.fromEntries(analysis.externalRefs.map((ref) => [ref.folder, ref]));
  assert.deepEqual(Object.keys(byFolder).sort(), ["libraries/Extra", "shared"]);
  assert.deepEqual(byFolder["libraries/Extra"].blocks, ["api"]);
  assert.deepEqual(byFolder["libraries/Extra"].from.map((entry) => entry.via), ["project reference"]);
  assert.deepEqual(byFolder.shared.blocks, ["app", "pages"]);
  assert.deepEqual([...new Set(byFolder.shared.from.map((entry) => entry.via))].sort(), ["import", "script"]);
  assert.ok(analysis.externalRefs.every((ref) => ref.access === "ask" && !ref.analyzed));
  // The one included is a normal dependency, not a pointer.
  assert.ok(analysis.dependencies.some((dep) => dep.from === "api" && dep.to === "core"));
  assert.ok(!analysis.externalRefs.some((ref) => ref.folder === "libraries/Core"));
  const findings = check(analysis, model({ include: ["webroot", "libraries/Core"] })).filter((finding) => finding.kind === "external-reference");
  assert.ok(findings.length >= 1);
});

test("without include nothing inside the root is external, as before", () => {
  const analysis = run(repo(), {});
  assert.deepEqual(analysis.externalRefs, []);
});

test("a path excluded by exclude is not an external folder: only include makes one", () => {
  const analysis = run(repo(), { include: ["webroot", "libraries/Core"], exclude: ["shared", "libraries/Extra"] });
  assert.deepEqual(analysis.externalRefs, []);
});

test("an allowed external folder inside the root is read read-only and its exports are searchable", () => {
  const root = repo();
  const m = { include: ["webroot", "libraries/Core"], externalRoots: { shared: "allow" } };
  const analysis = run(root, m);
  const shared = analysis.externalRefs.find((ref) => ref.folder === "shared");
  assert.equal(shared.access, "allow");
  assert.equal(shared.analyzed.files, 1);
  assert.deepEqual(shared.analyzed.catalog.map((entry) => entry.name), ["sharedPrice"]);
  assert.equal(shared.analyzed.catalog[0].file, "shared/util.js");
  assert.ok(!analysis.blocks.some((info) => info.files.some((file) => file.startsWith("shared/"))));
  assert.ok(!fs.existsSync(path.join(root, "shared/.cantus")), "nothing is written there");
});

test("untracked files and uncovered ones outside include are not reported", () => {
  const root = repo({ git: true });
  const wide = run(root, {}, { skipGit: false, model: model({}) });
  assert.ok(wide.uncovered.folders.some((entry) => entry.folder === "scripts") && wide.uncovered.folders.some((entry) => entry.folder === "shared"), JSON.stringify(wide.uncovered));
  const narrow = run(root, { include: ["webroot", "libraries/Core"] }, { skipGit: false });
  const folders = (narrow.uncovered?.folders ?? []).map((entry) => entry.folder);
  assert.ok(!folders.includes("shared") && !folders.includes("scripts"), folders.join(", "));
  const inside = run(root, { include: ["webroot", "shared/sync.ps1"] }, { skipGit: false });
  assert.deepEqual((inside.uncovered?.folders ?? []).map((entry) => entry.folder), ["shared"], "a file that is included and in no block is still said");
  const untracked = analyze(root, { skipGit: false, cache: false, model: model({ include: ["webroot", "libraries/Core"] }) });
  assert.deepEqual(untracked.untrackedBlocks ?? [], []);
});

test("a block whose folders are all outside include is an empty block, and the finding says why", () => {
  const root = repo();
  const m = model({ include: ["webroot", "libraries/Core"] });
  const findings = check(analyze(root, { skipGit: true, cache: false, model: m }), m).filter((finding) => finding.kind === "empty-block" && finding.blocks[0] === "legacy");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Block Legacy has no source files under legacy: they are outside `analysis\.include`/);
  const plain = model({});
  plain.blocks.push({ id: "ghost", name: "Ghost", layer: "domain", include: ["webroot/ghost"] });
  const other = check(analyze(root, { skipGit: true, cache: false, model: { ...plain, analysis: { include: ["webroot"] } } }), { ...plain, analysis: { include: ["webroot"] } }).find((finding) => finding.kind === "empty-block" && finding.blocks[0] === "ghost");
  assert.doesNotMatch(other.message, /analysis\.include/, "its folder is inside include; the files are really missing");
});

test("update_map keeps include and makes no block for files outside it", () => {
  const root = repo();
  const m = model({ include: ["webroot", "libraries/Core"] });
  fs.mkdirSync(path.join(root, "webroot/extra"), { recursive: true });
  fs.writeFileSync(path.join(root, "webroot/extra/new.js"), "export const n = 1;\n");
  fs.writeFileSync(path.join(root, "legacy/newer.js"), "export const n = 2;\n");
  const analysis = analyze(root, { skipGit: true, cache: false, model: m });
  const update = updateMap(root, analysis, m);
  assert.deepEqual(update.model.analysis.include, ["webroot", "libraries/Core"]);
  assert.ok(update.addedBlocks.length >= 1, "webroot/extra gets a block");
  assert.ok(update.model.blocks.every((block) => !block.include.some((p) => p.startsWith("shared") || p === "Test2")));
  assert.ok(update.emptyBlocks.includes("legacy"));
});

test("the live map notices a change in an included file and ignores one outside", () => {
  const root = repo();
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model({ include: ["webroot"] }), null, 2));
  const state = new ProjectState(root);
  const before = state.fingerprint();
  fs.writeFileSync(path.join(root, "legacy/old.js"), "export const old = 2;\n");
  assert.equal(state.fingerprint(), before, "outside include: not watched");
  fs.writeFileSync(path.join(root, "webroot/app/helper.js"), "export const help = () => 2;\n");
  assert.notEqual(state.fingerprint(), before);
  const snapshot = state.get();
  assert.ok(snapshot.analysis.blocks.every((info) => info.files.every((file) => file.startsWith("webroot/"))));
});

test("a model without include (and with today's externalRoots) validates and analyzes as before; a bad include is refused", () => {
  const old = model({ externalRoots: { "../x": "deny" } });
  assert.deepEqual(validateModel(old), []);
  assert.deepEqual(validateModel(model({ include: ["webroot"] })), []);
  assert.match(validateModel(model({ include: "webroot" })).join(), /analysis\.include must be a list of paths/);
  assert.match(validateModel(model({ include: [1] })).join(), /analysis\.include must be a list/);
});

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

test("set_external_access takes a folder inside the root that include leaves out", async () => {
  const root = repo();
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model({ include: ["webroot", "libraries/Core"] }), null, 2));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  try {
    const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
    assert.match(await call("map", {}), /## Points outside the map[\s\S]*`shared`[\s\S]*`libraries\/Extra`|## Points outside the map[\s\S]*`libraries\/Extra`[\s\S]*`shared`/);
    assert.match(await call("set_external_access", { folder: "legacy", access: "allow" }), /does not point to `legacy`.*libraries\/Extra/);
    assert.match(await call("set_external_access", { folder: "shared", access: "allow" }), /read-only is allowed/);
    const saved = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
    assert.deepEqual(saved.analysis.externalRoots, { shared: "allow" });
    assert.deepEqual(saved.analysis.include, ["webroot", "libraries/Core"], "include is kept");
    assert.match(await call("find_api", { query: "sharedPrice" }), /sharedPrice/);
  } finally {
    await client.close();
  }
});
