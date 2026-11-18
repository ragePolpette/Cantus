import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addSuggestions, analyze, buildContextPack, check, describeRefinement, dismissSuggestions, readSuggestions, renderContextPrompt } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

test("what refine suggests stays as findings until someone closes it, out of git and out of block briefings", () => {
  const root = copyFixture("shop");
  const model = shopModel();
  const found = [
    { block: "src-orders", kind: "split", text: "Invoices are a separate responsibility" },
    { block: "gone-block", kind: "merge", text: "Merge it" },
    { kind: "exclude", text: "Leave out the generated folder." },
  ];
  const added = addSuggestions(root, found);
  assert.equal(added.length, 3);
  assert.equal(addSuggestions(root, found).length, 0, "the same suggestion is kept once");
  assert.ok(fs.existsSync(path.join(root, ".cantus/cache/refine-suggestions.json")), "kept with the cache");

  const analysis = analyze(root, { model, skipGit: true });
  const findings = check(analysis, model).filter((finding) => finding.kind === "refine-suggestion");
  assert.equal(findings.length, 2, "a suggestion about a block that no longer exists is dropped");
  const [id] = added;
  assert.match(findings.find((finding) => finding.blocks[0] === "src-orders").message, new RegExp(`Refine suggests \\(split\\) for block \`src-orders\`: Invoices are a separate responsibility\\..*dismiss_suggestion ${id.id}`));
  assert.doesNotMatch(renderContextPrompt(buildContextPack(analysis, "src-orders", model, check(analysis, model)), { root, inlineSources: false }), /Refine suggests/);

  assert.match(describeRefinement({ applied: [], rejected: [], suggestions: [found[0]] }, 1), new RegExp(`\\[split\\] \\(${id.id}\\) src-orders:`));

  assert.equal(dismissSuggestions(root, [id.id]), 1);
  assert.equal(readSuggestions(root).length, 2);
  assert.equal(dismissSuggestions(root, "all"), 2);
  assert.ok(!fs.existsSync(path.join(root, ".cantus/cache/refine-suggestions.json")), "nothing left, no file");
  assert.equal(check(analyze(root, { model, skipGit: true }), model).filter((finding) => finding.kind === "refine-suggestion").length, 0);
});

test("an agent closes a suggestion with dismiss_suggestion and the findings follow; the terminal does the same", async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const [one, two] = addSuggestions(root, [{ block: "src-orders", kind: "split", text: "Split off invoices." }, { kind: "other", text: "Rename the root block." }]);

  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };

  assert.match((await call("check")).text, new RegExp(`Refine suggests \\(split\\).*dismiss_suggestion ${one.id}`));
  const wrong = await call("dismiss_suggestion", { ids: ["zzzzzz"] });
  assert.ok(wrong.isError);
  assert.match(wrong.text, new RegExp(`Open: ${one.id}, ${two.id}`));
  assert.match((await call("dismiss_suggestion", { ids: [one.id] })).text, /1 suggestion\(s\) closed\. 1 still open/);
  const after = (await call("check")).text;
  assert.doesNotMatch(after, /Split off invoices/);
  assert.match(after, /Rename the root block/);

  const listed = spawnSync(process.execPath, [cli, "suggestions", "-C", root], { encoding: "utf8" });
  assert.match(listed.stdout, new RegExp(`\\[other\\] \\(${two.id}\\) Rename the root block`));
  const closed = spawnSync(process.execPath, [cli, "suggestions", "dismiss", "all", "-C", root], { encoding: "utf8" });
  assert.match(closed.stdout, /1 suggestion\(s\) closed/);
  assert.match(spawnSync(process.execPath, [cli, "suggestions", "-C", root], { encoding: "utf8" }).stdout, /No open suggestions/);
});
