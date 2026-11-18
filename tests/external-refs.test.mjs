import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { analyze, buildContextPack, check, ProjectState, renderContextPrompt } from "../dist/index.js";
import { findCallers } from "../dist/analysis/callers.js";
import { outsideRoot } from "../dist/analysis/external.js";

/** A map rooted in `site/`, whose files point to `../lib` and `../common`: code the map does not hold. */
function project() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-external-"));
  const root = path.join(base, "site");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"site"}');
  write("api/Api.csproj", '<Project><ItemGroup><ProjectReference Include="..\\..\\lib\\Lib\\Lib.csproj" /><ProjectReference Include="..\\Core\\Core.csproj" /></ItemGroup></Project>');
  write("api/Orders.cs", "namespace Api { public class Orders { public int Count() { return 1; } } }\n");
  write("core/Core.csproj", "<Project></Project>");
  write("core/Core.cs", "namespace Core { public class Money { } }\n");
  write("js/app.js", 'import { shared } from "../../common/shared.js";\nimport { own } from "./own.js";\nexport const run = () => shared() + own();\n');
  write("js/own.js", "export const own = () => 1;\n");
  fs.mkdirSync(path.join(base, "common"), { recursive: true });
  fs.writeFileSync(path.join(base, "common/shared.js"), "/** Doubles an amount. */\nexport function sharedPrice(amount) { return amount * 2; }\nexport const SHARED_RATE = 2;\n");
  write("pages/home.html", '<html><body><script src="../../common/old.js"></script><script src="../js/app.js"></script></body></html>\n');
  return root;
}

const model = {
  version: 1,
  name: "site",
  blocks: [
    { id: "api", name: "Api", layer: "application", include: ["api"] },
    { id: "core", name: "Core", layer: "domain", include: ["core"] },
    { id: "js", name: "Js", layer: "interface", include: ["js"] },
    { id: "pages", name: "Pages", layer: "interface", include: ["pages"] },
  ],
  dependencies: [],
};

test("outsideRoot: only a relative path that leaves the root", () => {
  assert.equal(outsideRoot("js/app.js", "../../common/shared.js"), "../common/shared.js");
  assert.equal(outsideRoot("js/app.js", "../own.js"), undefined);
  assert.equal(outsideRoot("js/app.js", "./own.js"), undefined);
  assert.equal(outsideRoot("js/app.js", "/abs/x.js"), undefined);
  assert.equal(outsideRoot("js/app.js", "https://cdn.example.com/x.js"), undefined);
  assert.equal(outsideRoot("js/app.js", "lodash"), undefined);
  assert.equal(outsideRoot("a.js", "../x.js"), "../x.js");
});

test("the map notices a project reference, an import and a script that leave the root", () => {
  const analysis = analyze(project(), { skipGit: true, model });
  const byFolder = Object.fromEntries(analysis.externalRefs.map((ref) => [ref.folder, ref]));
  assert.deepEqual(Object.keys(byFolder).sort(), ["../common", "../lib/Lib"]);
  assert.deepEqual(byFolder["../lib/Lib"].blocks, ["api"]);
  assert.equal(byFolder["../lib/Lib"].from[0].via, "project reference");
  assert.deepEqual(byFolder["../common"].blocks, ["js", "pages"]);
  assert.deepEqual(byFolder["../common"].from.map((entry) => entry.via).sort(), ["import", "script"]);
  assert.ok(!analysis.externalRefs.some((ref) => ref.folder.includes("Core")), "a reference inside the root is not an external");
});

test("a project with nothing outside has no externals", () => {
  const root = project();
  fs.rmSync(path.join(root, "api/Api.csproj"));
  fs.rmSync(path.join(root, "js/app.js"));
  fs.rmSync(path.join(root, "pages/home.html"));
  assert.deepEqual(analyze(root, { skipGit: true, model }).externalRefs, []);
});

test("check says that blocks point outside, as information, and the briefing says the same", () => {
  const analysis = analyze(project(), { skipGit: true, model });
  const findings = check(analysis, model).filter((finding) => finding.kind === "external-reference");
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.severity === "info"));
  const lib = findings.find((finding) => finding.message.includes("../lib/Lib"));
  assert.match(lib.message, /Api \(api\) point to code outside the map/);
  assert.match(lib.message, /not analyzed/);

  const briefing = renderContextPrompt(buildContextPack(analysis, "api", model, findings), { root: analysis.root, inlineSources: false });
  assert.match(briefing, /Points to code outside the map \(not analyzed[^)]*\): `\.\.\/lib\/Lib` \(project reference, from `api\/Api\.csproj`\)/);
  const other = renderContextPrompt(buildContextPack(analysis, "core", model, []), { root: analysis.root, inlineSources: false });
  assert.doesNotMatch(other, /outside the map/);
});

const briefing = (analysis, findings, block) => renderContextPrompt(buildContextPack(analysis, block, model, findings), { root: analysis.root, inlineSources: false });
const withAccess = (access) => ({ ...model, analysis: { externalRoots: access } });

test("nobody has been asked yet: the finding and the briefing tell the agent to ask, and nothing outside is read", () => {
  const root = project();
  const analysis = analyze(root, { skipGit: true, model });
  assert.ok(analysis.externalRefs.every((ref) => ref.access === "ask" && !ref.analyzed));
  const findings = check(analysis, model);
  assert.match(findings.find((f) => f.message.includes("../common")).message, /ask the user, then record the answer with `set_external_access`/);
  assert.match(briefing(analysis, findings, "js"), /Nobody has decided yet whether Cantus may read `\.\.\/common`.*ask the user.*`set_external_access`/);
});

test("declined: the blocks only point to an external, and nobody asks again", () => {
  const analysis = analyze(project(), { skipGit: true, model: withAccess({ "../common": "deny", "../lib/Lib": "deny" }) });
  const m = withAccess({ "../common": "deny", "../lib/Lib": "deny" });
  const findings = check(analysis, m);
  assert.ok(analysis.externalRefs.every((ref) => ref.access === "deny" && !ref.analyzed));
  assert.ok(findings.some((f) => f.kind === "external-reference"), "still reported");
  assert.ok(findings.every((f) => !/set_external_access/.test(f.message)));
  const text = renderContextPrompt(buildContextPack(analysis, "js", m, findings), { root: analysis.root, inlineSources: false });
  assert.match(text, /Points to code outside the map \(not analyzed/);
  assert.doesNotMatch(text, /Nobody has decided|set_external_access/);
});

test("allowed: the folder is read read-only and its exports are kept apart from the blocks", () => {
  const root = project();
  const m = withAccess({ "../common": "allow", "../lib/Lib": "deny" });
  const analysis = analyze(root, { skipGit: true, model: m });
  const common = analysis.externalRefs.find((ref) => ref.folder === "../common");
  assert.equal(common.access, "allow");
  assert.equal(common.analyzed.files, 1);
  assert.deepEqual(common.analyzed.catalog.map((entry) => entry.name).sort(), ["SHARED_RATE", "sharedPrice"]);
  assert.ok(common.analyzed.catalog.every((entry) => entry.block === "../common" && entry.file === "../common/shared.js"));
  assert.ok(!analysis.catalog.some((entry) => entry.name === "sharedPrice"), "not a block of the map");
  assert.ok(!analysis.blocks.some((info) => info.files.some((file) => file.startsWith(".."))));
  assert.ok(!fs.existsSync(path.join(root, "../common/.cantus")), "nothing is written in the external folder");
  assert.ok(!check(analysis, m).some((f) => f.message.includes("../common")), "an allowed folder is not a finding");
  const text = briefing(analysis, [], "js").replace(/\n/g, " ");
  assert.match(text, /Outside the map, read-only \(the user allowed the analysis\): `\.\.\/common`, 1 file\(s\).*`sharedPrice`/);
  assert.match(text, /do not edit it from here/);
  assert.match(briefing(analysis, [], "api"), /Points to code outside the map.*`\.\.\/lib\/Lib`/, "the other one, not allowed, is still only a pointer");
});

test("allowed but missing: said so, no crash", () => {
  const root = project();
  fs.rmSync(path.join(root, "../common"), { recursive: true });
  const analysis = analyze(root, { skipGit: true, model: withAccess({ "../common": "allow" }) });
  const common = analysis.externalRefs.find((ref) => ref.folder === "../common");
  assert.equal(common.analyzed, undefined);
  assert.match(briefing(analysis, [], "js"), /allowed reading it, but the folder is missing or unreadable/);
});

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

test("set_external_access records the answer in the map; find_api then searches the allowed folder", async () => {
  const root = project();
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  try {
    const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
    assert.match(await call("map", {}), /## Points outside the map[\s\S]*`\.\.\/common`.*not analyzed yet; ask the user/);
    assert.match(await call("set_external_access", { folder: "../nowhere", access: "allow" }), /does not point to `\.\.\/nowhere`.*\.\.\/common/);
    assert.match(await call("find_api", { query: "sharedPrice" }), /No exported symbol/);

    assert.match(await call("set_external_access", { folder: "../common", access: "allow" }), /read-only is allowed/);
    const saved = JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8"));
    assert.deepEqual(saved.analysis.externalRoots, { "../common": "allow" });
    const found = await call("find_api", { query: "sharedPrice" });
    assert.match(found, /Outside the map \(read-only[^)]*\):\n\[\.\.\/common\] \.\.\/common\/shared\.js: .*sharedPrice/);
    assert.match(await call("map", {}), /`\.\.\/common`.*read-only analysis allowed: 1 file\(s\), 2 export\(s\)/);

    assert.match(await call("set_external_access", { folder: "../common", access: "deny" }), /not analyzed/);
    assert.match(await call("find_api", { query: "sharedPrice" }), /No exported symbol/);
    assert.match(await call("set_external_access", { folder: "../common", access: "ask" }), /forgotten/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8")).analysis.externalRoots, undefined);
  } finally {
    await client.close();
  }
});

test("what the blocks name of an allowed external folder shows as callers (by name) and in their briefing", () => {
  const root = project();
  fs.writeFileSync(path.join(root, "js/own.js"), "import { sharedPrice } from \"../../common/shared.js\";\nexport const own = (n) => sharedPrice(n) + 1;\n// sharedPrice in a comment is not a use\n");
  const m = withAccess({ "../common": "allow", "../lib/Lib": "deny" });
  const analysis = analyze(root, { skipGit: true, model: m });
  const answer = findCallers(analysis, { symbol: "sharedPrice" });
  assert.deepEqual(answer.sites.map((site) => [site.file, site.line, site.via, site.match]), [
    ["js/own.js", 1, "external", "by-name"],
    ["js/own.js", 2, "external", "by-name"],
  ]);
  assert.equal(answer.sites[0].targetFile, "../common/shared.js");
  assert.equal(analysis.callSites.filter((site) => site.via === "external").every((site) => !site.targetBlock), true, "the folder is no block");

  const text = briefing(analysis, [], "js").replace(/\n/g, " ");
  assert.match(text, /What this block seems to use of `\.\.\/common`.*sharedPrice.*`\.\.\/common\/shared\.js`\), named in 2 place\(s\), first `js\/own\.js:1`/);
  // Another block does not name it, a folder not allowed gives nothing.
  assert.doesNotMatch(briefing(analysis, [], "api"), /seems to use/);
  const denied = analyze(root, { skipGit: true, model: withAccess({ "../common": "deny" }) });
  assert.deepEqual(denied.callSites.filter((site) => site.via === "external"), []);
});

test("an allowed external C# folder is read without creating a cache there", t => {
  const root = project();
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  const external = path.resolve(root, "../lib/Lib");
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, "Lib.csproj"), "<Project />");
  fs.writeFileSync(path.join(external, "Shared.cs"), "namespace Lib { public class Shared {} }");
  const result = analyze(root, { model: withAccess({ "../lib/Lib": "allow" }) });
  assert.ok(result.externalRefs.find(ref => ref.folder === "../lib/Lib")?.analyzed?.catalog.some(entry => entry.name === "Shared"));
  assert.ok(!fs.existsSync(path.join(external, ".cantus")), "external folders are read-only");
});

test("a live snapshot refreshes when a C# external or a project reference changes", t => {
  const root = project();
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  const external = path.resolve(root, "../lib/Lib");
  fs.mkdirSync(external, { recursive: true });
  const source = path.join(external, "Shared.cs");
  fs.writeFileSync(source, "namespace Lib { public class Shared {} }");
  fs.mkdirSync(path.join(root, ".cantus"));
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(withAccess({ "../lib/Lib": "allow" })));

  const state = new ProjectState(root);
  const first = state.get();
  fs.writeFileSync(source, "namespace Lib { public class RenamedShared {} }");
  const second = state.get();
  assert.notEqual(second.fingerprint, first.fingerprint);

  fs.writeFileSync(path.join(root, "api/Api.csproj"), "<Project />");
  const third = state.get();
  assert.notEqual(third.fingerprint, second.fingerprint);
  assert.ok(!third.analysis.externalRefs.some(ref => ref.folder === "../lib/Lib"));
});
