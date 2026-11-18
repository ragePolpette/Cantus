import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { queryRoslyn } from "../dist/analysis/roslyn.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("Roslyn CLI requires explicit trust", () => {
  const result = spawnSync(process.execPath, [cli, "csharp", "references", "Foo.cs", "1", "1"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--trust/);
});

test("Roslyn opens a solution, waits for readiness and queries a UTF-16 position", { skip: process.platform === "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-roslyn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rpcModule = createRequire(import.meta.url).resolve("vscode-jsonrpc/node.js");
  const executable = path.join(root, "server.cjs");
  fs.writeFileSync(path.join(root, "App.sln"), "");
  fs.writeFileSync(path.join(root, "Foo.cs"), "class Foo {}");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require(${JSON.stringify(rpcModule)});
const rpc = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
let opened = false;
rpc.onRequest("initialize", () => ({ capabilities: { referencesProvider: true } }));
rpc.onNotification("initialized", () => {});
rpc.onNotification("solution/open", ({ solution }) => {
  assert.equal(solution, ${JSON.stringify(pathToFileURL(path.join(fs.realpathSync(root), "App.sln")).href)});
  opened = true;
});
rpc.onNotification("textDocument/didOpen", async () => {
  assert.ok(opened);
  await rpc.sendNotification("workspace/projectInitializationComplete");
});
rpc.onRequest("textDocument/references", params => {
  assert.deepEqual(params.position, { line: 0, character: 6 });
  assert.equal(params.context.includeDeclaration, false);
  return [{ uri: params.textDocument.uri }];
});
rpc.onRequest("shutdown", () => null);
rpc.onNotification("exit", () => rpc.dispose());
rpc.listen();
`, { mode: 0o755 });
  const result = await queryRoslyn(root, executable, "App.sln", "Foo.cs", 1, 7, "references", 3000);
  assert.deepEqual(result, {
    provider: "roslyn", query: "references", warnings: [],
    result: [{ uri: pathToFileURL(path.join(fs.realpathSync(root), "Foo.cs")).href }],
  });
});
