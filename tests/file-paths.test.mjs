import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyze, projectFile, resolveScope } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/** The shop as a subfolder of a git repository, with a block that takes whatever no other block claims. */
function shopInRepo() {
  const top = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-paths-"));
  const root = path.join(top, "app");
  fs.cpSync(copyFixture("shop"), root, { recursive: true });
  const model = shopModel();
  model.blocks.push({ id: "rest", name: "Rest", layer: "interface", include: ["."] });
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  const run = (...args) => execFileSync("git", args, { cwd: top, stdio: "pipe", encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return { root, model };
}

test("a file path is read relative to the map's root, from the git root, or absolute", () => {
  const { root, model } = shopInRepo();
  const analysis = analyze(root, { model, skipGit: true });
  assert.equal(projectFile(analysis, "src/orders/index.ts"), "src/orders/index.ts");
  assert.equal(projectFile(analysis, "./src/orders/index.ts"), "src/orders/index.ts");
  assert.equal(projectFile(analysis, "src\\orders\\index.ts"), "src/orders/index.ts", "Windows separators");
  assert.equal(projectFile(analysis, "app/src/orders/index.ts"), "src/orders/index.ts", "from the git root");
  assert.equal(projectFile(analysis, path.join(root, "src/orders/index.ts")), "src/orders/index.ts", "absolute");
  assert.equal(resolveScope(analysis, model, { file: "app/src/orders/index.ts" }).scope.id, "src-orders");
});

test("a file that is not in the project is an error, not the root block's briefing", () => {
  const { root, model } = shopInRepo();
  const analysis = analyze(root, { model, skipGit: true });
  assert.throws(() => resolveScope(analysis, model, { file: "nope/orders.ts" }), /No file "nope\/orders\.ts" under the map's root/);
  assert.throws(() => resolveScope(analysis, model, { file: "other/src/orders/nope.ts" }), /No file "other\/src\/orders\/nope\.ts" under the map's root/);
  assert.equal(resolveScope(analysis, model, { file: "src/orders/refund.ts" }).scope.id, "src-orders", "a file to be created in a block's folder");
  assert.equal(resolveScope(analysis, model, { file: "app/src/orders/refund.ts" }).scope.id, "src-orders", "the same, from the git root");
  assert.throws(() => resolveScope(analysis, model, { file: "other/src/orders/index.ts" }), /No file "other\/src\/orders\/index\.ts"[^]*Files with that name: `src\/orders\/index\.ts`, `src\/checkout\/index\.ts`/);
  assert.throws(() => resolveScope(analysis, model, { file: path.join(path.dirname(root), "README.md") }), /outside the map's root/);
  assert.equal(resolveScope(analysis, model, { file: "package.json" }).scope.id, "rest", "a real file nobody claims still goes to the block that takes the rest");
});

test("MCP: block_context and callers refuse an unknown file and accept the git-root path", async (t) => {
  const { root } = shopInRepo();
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };

  const ok = await call("block_context", { file: "app/src/orders/index.ts" });
  assert.match(ok.text, /^# Block: Orders \(`src-orders`\)/);
  const missing = await call("block_context", { file: "nope/orders.ts" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No file "nope\/orders\.ts"/);
  assert.match((await call("callers", { file: "app/src/orders/index.ts" })).text, /call site\(s\)/);
  assert.equal((await call("callers", { file: "nope/orders.ts" })).isError, true);
});
