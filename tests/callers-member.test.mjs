import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyze, findCallers } from "../dist/index.js";
import { fixtures } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function project() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-members-"));
  fs.mkdirSync(path.join(root, "src/mail"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/app"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/other"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/mail/mailer.ts"), "export class Mailer {\n  send(to: string): boolean { return to.length > 0; }\n  count = 0;\n}\nexport function unused(): number { return 1; }\n");
  fs.writeFileSync(path.join(root, "src/mail/index.ts"), 'export { Mailer } from "./mailer";\n');
  fs.writeFileSync(path.join(root, "src/app/main.ts"), 'import { Mailer } from "../mail/mailer";\n\nconst mailer = new Mailer();\n// mailer.send is described here\nmailer.send("a@b.c");\nexport const total = mailer.count;\n');
  fs.writeFileSync(path.join(root, "src/other/lonely.ts"), 'export function send(x: string): string { return x; }\n');
  return root;
}

test("callers: Type.member finds the member's uses in the files that use the type", () => {
  const analysis = analyze(project(), { skipGit: true });
  const { sites, notes } = findCallers(analysis, { symbol: "Mailer.send" });
  assert.deepEqual(sites.map((site) => `${site.file}:${site.line}`), ["src/app/main.ts:5"], "the comment line is not a call");
  assert.equal(sites[0].match, "by-name");
  assert.match(notes.join("\n"), /looked for by name in the files that use `Mailer`/);
  assert.deepEqual(findCallers(analysis, { symbol: "Mailer.count" }).sites.map((site) => site.line), [6]);
});

test("callers: a method named alone is resolved to its type, or said not to be an export", () => {
  const analysis = analyze(project(), { skipGit: true });
  const bare = findCallers(analysis, { symbol: "count" });
  assert.deepEqual(bare.sites.map((site) => site.line), [6]);
  assert.match(bare.notes[0], /`count` is not an export; it is a member of `Mailer`, so this answers for `Mailer\.count`/);

  const nothing = findCallers(analysis, { symbol: "nowhere" });
  assert.equal(nothing.sites.length, 0);
  assert.match(nothing.notes[0], /`nowhere` is not an export Cantus indexes/);
  assert.match(findCallers(analysis, { symbol: "Ghost.send" }).notes[0], /`Ghost` is not an export indexed by Cantus/);

  const unused = findCallers(analysis, { symbol: "unused" });
  assert.match(unused.notes[0], /is an export, and nothing in the project calls it/);
});

test("callers: C# controller action by its bare name resolves to the endpoint calls", () => {
  const analysis = analyze(path.join(fixtures, "csharp"), { skipGit: true });
  const { sites, notes } = findCallers(analysis, { symbol: "Create" });
  assert.ok(sites.some((site) => site.symbol === "OrdersController.Create" && site.file === "web/js/orders.js"), "the HTTP call from the page");
  assert.match(notes.join("\n"), /member of `OrdersController`/);
});

test("MCP callers: the answer says when the name is not an export", async (t) => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", project()], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (args) => (await client.callTool({ name: "callers", arguments: args })).content.map((part) => part.text).join("\n");
  assert.match(await call({ symbol: "nowhere" }), /not an export Cantus indexes/);
  assert.doesNotMatch(await call({ symbol: "nowhere" }), /No callers found/);
  const member = await call({ symbol: "Mailer.send" });
  assert.match(member, /1 call site\(s\)/);
  assert.match(member, /`src\/app\/main\.ts:5`/);
});
