import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, check, renderMermaid } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

test("the block graph is a flowchart: layers as groups, one arrow per dependency", () => {
  const model = shopModel();
  const analysis = analyze(copyFixture("shop"), { model, skipGit: true });
  const graph = renderMermaid(analysis, model, check(analysis, model));
  assert.match(graph, /^flowchart TB\n/);
  for (const layer of ["interface", "application", "domain", "infrastructure"]) assert.match(graph, new RegExp(`subgraph L\\d\\["${layer}"\\]`));
  assert.match(graph, /\["Orders<br\/>1 file"\]/);
  const arrows = graph.split("\n").filter((line) => /^  b\d+ [-.=]+>? b\d+$/.test(line));
  assert.equal(arrows.length, analysis.dependencies.length, "every dependency in the code is drawn once");
  assert.ok(arrows.every((line) => line.includes("-->") || line.includes("==>") || line.includes("-.->")));
});

test("arrows say what is wrong: not in the map, breaking a layer rule, planned", () => {
  const block = (id, name, layer) => ({ block: { id, name, layer }, files: ["a.ts"] });
  const analysis = {
    blocks: [block("end", 'Say "hi" <b> & co', "interface"), block("domain", "Domain", "domain"), block("db", "Db", "infrastructure")],
    dependencies: [{ from: "end", to: "domain" }, { from: "domain", to: "db" }, { from: "end", to: "db" }],
  };
  const model = { version: 1, name: "t", layers: ["interface", "domain", "infrastructure"], blocks: [], dependencies: [{ from: "db", to: "end" }] };
  const findings = [
    { kind: "layer-violation", from: "end", to: "db", blocks: [] },
    { kind: "undeclared-dependency", from: "domain", to: "db", blocks: [] },
  ];
  const graph = renderMermaid(analysis, model, findings);
  assert.match(graph, /b1\["Say #quot;hi#quot; #lt;b#gt; #amp; co<br\/>1 file"\]/, "names cannot break the syntax");
  assert.match(graph, /\n  b1 --> b2\n  b2 -\.-> b3\n  b1 ==> b3\n  b3 -\.- b1\n/);
  assert.match(graph, /\n  linkStyle 2 stroke:#dc2626/);
  // Block ids such as "end" or "graph" are Mermaid keywords: boxes get their own ids.
  assert.doesNotMatch(graph, /\bend\[/);
});

test("`cantus mermaid` prints the graph, optionally in a Markdown fence", () => {
  const root = copyFixture("shop");
  const run = (...args) => spawnSync(process.execPath, [cli, "mermaid", ...args, "-C", root], { encoding: "utf8" });
  const plain = run();
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /^flowchart TB\n/);
  const fenced = run("--markdown");
  assert.equal(fenced.status, 0);
  assert.match(fenced.stdout, /^```mermaid\nflowchart TB\n[\s\S]*\n```\n$/);
});
